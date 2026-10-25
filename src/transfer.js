/**
 * ZMODEM 文件传输：`rz` 上传 / `sz` 下载。
 *
 * ── 为什么跑在 Host 而不是浏览器 ──────────────────────────────────────
 * 终端字节流的唯一真相源在 Host（ssh2 → SSE 分发）。把协议机放在这里：
 * - 天然拿到全部字节，不用给浏览器再开一条带外通道；
 * - 传输期间可以直接**停止向 xterm 广播**这些字节（否则用户看到乱码）；
 * - 收到的文件直接落盘，下载走一次普通 HTTP 即可。
 * 代价是上传多一跳（浏览器 → Host → PTY），换来客户端零协议状态。
 *
 * ── 协议方向（以用户视角） ────────────────────────────────────────────
 * - `rz`（上传）：远端 lrzsz 收到 ZRINIT 就绪 → 我们的 Sentry 建出 **send**
 *   会话 → 向客户端要文件 → `send_offer` → 分片 `xfer.send()` → `xfer.end()`。
 * - `sz`（下载）：远端 lrzsz 发 ZRQINIT → Sentry 建出 **receive** 会话 →
 *   `session.start()` 回 ZRINIT → 对端发 ZFILE（offer）→ `accept()` 收载荷
 *   → 落盘 → 通知客户端下载。
 *
 * ── 两个实测踩出来的坑（2026-10-25，本机 lrzsz 端到端验证） ───────────
 * 1. `zmodem.js` 的 hex 字符表只认小写（`HEX_DIGITS` 到 102 即 'f' 为止），
 *    遇到大写 A-F 会解析成 NaN。lrzsz 自己发小写，但别的实现不一定，所以
 *    这里在运行时给 `ENCODELIB.parse_hex_octets` 打一层大小写归一化，
 *    **不改 node_modules**（也就不需要 patch-package）。
 * 2. Sentry 的检测要求"ZMODEM 头恰好是缓冲区的结尾"（`_parse` 里 cache 非空
 *    就返回 null）。远端把 `帧 + CR/LF/XON` 一次吐过来时整块喂会漏检，
 *    所以**检测阶段逐字节喂**，会话建立后再整块喂。
 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
// eslint-disable-next-line import/no-unresolved -- 运行期依赖，见 package.json
const Zmodem = require('zmodem.js');

// 坑 1：大写 hex 归一化（库的字符表只认小写）。ENCODELIB 是导出对象上的方法，
// 调用时才查找，所以运行时替换即可生效。
const parseHexOctets = Zmodem.ENCODELIB.parse_hex_octets;
Zmodem.ENCODELIB.parse_hex_octets = (codes) => parseHexOctets(codes.map((code) => (code >= 65 && code <= 70 ? code + 32 : code)));

/** 发送分片大小（库的上限是 8192，lrzsz 也接受）。 */
const CHUNK_BYTES = 8192;
/** 等用户选文件的超时：远端 `rz` 自己也有超时，别比它更久。 */
const PICK_FILE_TIMEOUT_MS = 60000;
/** 接收文件的临时目录。 */
const TRANSFER_DIR = join(tmpdir(), 'dsh-ssh-transfers');

/**
 * 造传输管理器。
 * @param {object} options 参数。
 * @param {object} options.service SshSessionService（会话 + 字节流 + 写 PTY）。
 * @param {(message: string) => void} [options.logger] 日志函数。
 * @returns {object} 管理器。
 */
export function createTransferManager(options = {}) {
  const service = options.service;
  if (service === undefined || service === null) {
    throw new TypeError('dsh-ssh transfer: service is required');
  }
  const logger = typeof options.logger === 'function' ? options.logger : () => {};

  /** sid -> 传输上下文 { sentry, session, mode, unsub, timer, pending }。 */
  const contexts = new Map();
  /** sid -> Set<(event: object) => void>（SSE 控制帧的订阅者）。 */
  const listeners = new Map();

  /**
   * 广播一个传输事件给该会话的所有订阅者。
   * @param {string} sid 会话 id。
   * @param {object} event 事件。
   * @returns {void}
   */
  const emit = (sid, event) => {
    for (const listener of listeners.get(sid) ?? []) {
      try {
        listener(event);
      } catch {
        // 订阅者抛错不该影响传输本身（SSE 断开时会走解绑）。
      }
    }
  };

  /**
   * 该会话是否正在传输（SSE 据此停止向 xterm 广播字节）。
   * @param {string} sid 会话 id。
   * @returns {boolean} 传输中返回 true。
   */
  const isActive = (sid) => {
    const context = contexts.get(sid);
    return context !== undefined && context.session !== null;
  };

  /**
   * 订阅传输事件。
   * @param {string} sid 会话 id。
   * @param {(event: object) => void} listener 回调。
   * @returns {() => void} 取消订阅。
   */
  const onEvent = (sid, listener) => {
    const set = listeners.get(sid) ?? new Set();
    set.add(listener);
    listeners.set(sid, set);
    return () => set.delete(listener);
  };

  /**
   * 收尾一个会话的传输状态（协议结束 / 出错 / 会话关闭）。
   * @param {string} sid 会话 id。
   * @returns {void}
   */
  const settle = (sid) => {
    const context = contexts.get(sid);
    if (context === undefined) return;
    if (context.timer !== null) clearTimeout(context.timer);
    if (typeof context.unsub === 'function') context.unsub();
    contexts.delete(sid);
  };

  /**
   * 处理"对端要收文件"（rz）：建出 send 会话后向客户端要文件。
   * @param {string} sid 会话 id。
   * @param {object} session ZMODEM send 会话。
   * @returns {void}
   */
  const beginUpload = (sid, session) => {
    const context = contexts.get(sid);
    if (context === undefined) return;
    context.session = session;
    context.mode = 'send';
    emit(sid, { type: 'transfer', phase: 'start', mode: 'send' });
    emit(sid, { type: 'transfer', phase: 'need-file' });
    // 远端 rz 等不了多久；超时就当用户放弃了，把会话状态清掉。
    context.timer = setTimeout(() => {
      logger(`transfer: no file picked for ${sid}, giving up`);
      emit(sid, { type: 'transfer', phase: 'error', message: '等待选择文件超时' });
      settle(sid);
      emit(sid, { type: 'transfer', phase: 'end', mode: 'send' });
    }, PICK_FILE_TIMEOUT_MS);
  };

  /**
   * 处理"对端要发文件"（sz）：ZRQINIT → receive 会话 → 逐个 offer 接收。
   * @param {string} sid 会话 id。
   * @param {object} session ZMODEM receive 会话。
   * @returns {void}
   */
  const beginDownload = (sid, session) => {
    const context = contexts.get(sid);
    if (context === undefined) return;
    context.session = session;
    context.mode = 'receive';
    emit(sid, { type: 'transfer', phase: 'start', mode: 'receive' });
    // start() 负责回 ZRINIT，并返回"下一个文件"的 promise。
    session.start().then(async (offer) => {
      if (offer === undefined || offer === null) {
        emit(sid, { type: 'transfer', phase: 'end', mode: 'receive' });
        settle(sid);
        return;
      }
      const details = offer.get_details?.() ?? {};
      const name = String(details.name ?? 'download.bin');
      const size = Number(details.size ?? 0);
      emit(sid, { type: 'transfer', phase: 'offer', mode: 'receive', name, size });
      let payloads = [];
      try {
        // 不传 on_input：让 Offer 自己攒载荷，accept() 的 promise 直接给数组。
        payloads = (await offer.accept()) ?? [];
      } catch (error) {
        logger(`transfer: receive failed for ${sid}: ${error?.message ?? error}`);
        emit(sid, { type: 'transfer', phase: 'error', mode: 'receive', message: String(error?.message ?? error) });
        emit(sid, { type: 'transfer', phase: 'end', mode: 'receive' });
        settle(sid);
        return;
      }
      const data = Buffer.concat(payloads.map((part) => Buffer.from(part)));
      try {
        await mkdir(TRANSFER_DIR, { recursive: true });
        const path = join(TRANSFER_DIR, `${sid}-${name}`);
        await writeFile(path, data);
        emit(sid, { type: 'transfer', phase: 'complete', mode: 'receive', name, size: data.length, path });
      } catch (error) {
        logger(`transfer: cannot write ${name}: ${error?.message ?? error}`);
        emit(sid, { type: 'transfer', phase: 'error', mode: 'receive', message: `写文件失败：${error?.message ?? error}` });
      }
      emit(sid, { type: 'transfer', phase: 'end', mode: 'receive' });
      settle(sid);
    }).catch((error) => {
      logger(`transfer: receive session failed for ${sid}: ${error?.message ?? error}`);
      emit(sid, { type: 'transfer', phase: 'error', mode: 'receive', message: String(error?.message ?? error) });
      emit(sid, { type: 'transfer', phase: 'end', mode: 'receive' });
      settle(sid);
    });
  };

  /**
   * 给某个会话挂上字节嗅探。重复调用是幂等的。
   * @param {string} sid 会话 id。
   * @returns {void}
   */
  const attach = (sid) => {
    if (contexts.has(sid)) return;
    /** @type {object} */
    const context = { sentry: null, session: null, mode: null, unsub: null, timer: null };
    contexts.set(sid, context);

    context.sentry = new Zmodem.Sentry({
      // 传输期间的协议字节不进终端：SSE 那一侧已经停止广播了。
      to_terminal: () => {},
      on_detect: (detection) => {
        const session = detection.confirm();
        if (session.type === 'send') beginUpload(sid, session);
        else beginDownload(sid, session);
      },
      on_retract: () => {},
      // 协议帧写进 PTY：这就是"我们这一侧"的嘴。
      sender: (octets) => {
        try {
          service.send(sid, Buffer.from(octets));
        } catch (error) {
          logger(`transfer: cannot write to ${sid}: ${error?.message ?? error}`);
        }
      },
    });

    context.unsub = service.subscribe(sid, (event) => {
      if (event?.kind !== 'data') return;
      const bytes = new Uint8Array(Buffer.from(event.data, 'base64'));
      // 坑 2：检测阶段逐字节喂，否则"帧 + CR/LF/XON"整块到达会漏检。
      if (context.session === null) {
        for (let index = 0; index < bytes.length; index += 1) {
          context.sentry.consume([bytes[index]]);
          if (context.session !== null) {
            // 会话已建立：剩下的字节整块交给它。
            if (index + 1 < bytes.length) context.sentry.consume(bytes.subarray(index + 1));
            return;
          }
        }
        return;
      }
      context.sentry.consume(bytes);
    });
  };

  /**
   * 摘掉某个会话的嗅探（会话关闭 / 插件卸载）。
   * @param {string} sid 会话 id。
   * @returns {void}
   */
  const detach = (sid) => settle(sid);

  /**
   * 用户选好了文件：把它发出去（`rz` 流程的后半段）。
   * @param {string} sid 会话 id。
   * @param {{name: string, data: Buffer}} file 文件名与内容。
   * @returns {Promise<{ok: boolean, error?: string}>} 发送结果。
   */
  const sendFile = async (sid, file) => {
    const context = contexts.get(sid);
    if (context === undefined || context.session === null || context.mode !== 'send') {
      return { ok: false, error: '当前没有等待上传的会话' };
    }
    const session = context.session;
    const name = String(file?.name ?? 'upload.bin');
    const data = Buffer.isBuffer(file?.data) ? file.data : Buffer.from(file?.data ?? []);
    if (context.timer !== null) clearTimeout(context.timer);
    context.timer = null;
    try {
      const xfer = await session.send_offer({
        name,
        size: data.length,
        mtime: new Date(),
        files_remaining: 1,
        bytes_remaining: data.length,
      });
      if (xfer === undefined) {
        emit(sid, { type: 'transfer', phase: 'error', mode: 'send', message: '对端拒绝了这个文件' });
        emit(sid, { type: 'transfer', phase: 'end', mode: 'send' });
        settle(sid);
        return { ok: false, error: '对端拒绝了这个文件' };
      }
      emit(sid, { type: 'transfer', phase: 'sending', mode: 'send', name, size: data.length, offset: 0 });
      for (let offset = 0; offset < data.length; offset += CHUNK_BYTES) {
        xfer.send(data.subarray(offset, offset + CHUNK_BYTES));
        emit(sid, { type: 'transfer', phase: 'progress', mode: 'send', name, size: data.length, offset: xfer.get_offset() });
      }
      await xfer.end();
      emit(sid, { type: 'transfer', phase: 'complete', mode: 'send', name, size: data.length });
      emit(sid, { type: 'transfer', phase: 'end', mode: 'send' });
      settle(sid);
      return { ok: true };
    } catch (error) {
      const message = String(error?.message ?? error);
      logger(`transfer: send failed for ${sid}: ${message}`);
      emit(sid, { type: 'transfer', phase: 'error', mode: 'send', message });
      emit(sid, { type: 'transfer', phase: 'end', mode: 'send' });
      settle(sid);
      return { ok: false, error: message };
    }
  };

  /**
   * 全部收尾（插件卸载）。
   * @returns {void}
   */
  const dispose = () => {
    for (const sid of [...contexts.keys()]) settle(sid);
    listeners.clear();
  };

  return { attach, detach, isActive, onEvent, sendFile, dispose };
}
