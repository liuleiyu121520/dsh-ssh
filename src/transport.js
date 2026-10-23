/**
 * 传输层：把"一个 SSH 连接"抽象成 sessions.js 需要的最小接口。
 *
 * sessions.js 只认这个契约（createTransport(config, handlers) -> transport）：
 * - handlers.onReady()              通道可用
 * - handlers.onData(chunk)          远端输出（Buffer 或字符串）
 * - handlers.onError(error)         连接 / 通道错误
 * - handlers.onExit({code})         远端关闭
 * - transport.send(bytes)           写键盘字节
 * - transport.resize(cols, rows)    改窗口尺寸
 * - transport.close()               主动收尾
 * - transport.uploadFile(local, remote)   **可选**：SFTP 上传
 * - transport.downloadFile(remote, local) **可选**：SFTP 下载
 *
 * 两个实现：createSsh2Transport 走真实 ssh2；createFakeTransport 是测试替身，
 * 不起网络、不依赖 sshd，用来验证"远端输出 -> 缓冲 -> SSE 帧"的端到端路径。
 *
 * 传输层是**唯一**能看到明文口令/私钥的地方：`config` 由
 * `sessions.buildTransportConfig()` 拼好后直接交进来，本模块不缓存、不复制
 * 到闭包之外的任何地方（`connection.connect()` 之后也不再引用）。
 */
import { statSync } from 'node:fs';
import { Client } from 'ssh2';

/** ssh2 连接阶段超时（毫秒）。本机连不通时不该把用户晾太久。 */
const READY_TIMEOUT_MS = 10000;

/**
 * 用 ssh2 开一个 shell 通道。
 *
 * 握手、认证、开 shell 全是异步的；本函数同步返回 transport 对象，后续状态
 * 通过 handlers 上报。`disposed` 守卫保证主动 close() 之后迟到的 error /
 * close 事件不会再改会话状态机。
 * @param {object} config 连接配置（host/port/username/password/privateKey/passphrase/cols/rows）。
 * @param {object} handlers 事件回调（onReady/onData/onError/onExit）。
 * @returns {object} transport 对象。
 */
export function createSsh2Transport(config, handlers = {}) {
  const { host, port, username, password, privateKey, passphrase } = config;
  const cols = Number.isInteger(config.cols) && config.cols > 0 ? config.cols : 80;
  const rows = Number.isInteger(config.rows) && config.rows > 0 ? config.rows : 24;

  const connection = new Client();
  /** @type {import('ssh2').ClientChannel|null} */
  let stream = null;
  let disposed = false;

  connection.on('ready', () => {
    if (disposed) return;
    connection.shell({ term: 'xterm-256color', cols, rows }, (error, channel) => {
      if (disposed) return;
      if (error !== null && error !== undefined) {
        handlers.onError?.(error);
        return;
      }
      stream = channel;
      channel.on('data', (data) => {
        if (!disposed) handlers.onData?.(data);
      });
      channel.on('close', () => {
        if (disposed) return;
        disposed = true;
        handlers.onExit?.({ code: channel.exitCode ?? null });
      });
      channel.on('error', (channelError) => {
        if (!disposed) handlers.onError?.(channelError);
      });
      handlers.onReady?.();
    });
  });

  connection.on('error', (error) => {
    if (disposed) return;
    disposed = true;
    handlers.onError?.(error);
  });

  connection.on('close', () => {
    if (disposed) return;
    disposed = true;
    handlers.onExit?.({ code: null });
  });

  connection.connect({
    host,
    port,
    username: username === '' || username === undefined ? process.env.USER ?? process.env.USERNAME ?? undefined : username,
    password: password === '' ? undefined : password,
    privateKey: privateKey === '' ? undefined : privateKey,
    passphrase: passphrase === '' ? undefined : passphrase,
    readyTimeout: READY_TIMEOUT_MS,
    // 交互式 shell 不需要 keepalive 之外的任何服务器端 hack。
    keepaliveInterval: 15000,
  });

  /**
   * 开一个 SFTP 会话并在结束时关闭它。
   * @param {(sftp: object) => Promise<void>} run 使用 sftp 的回调。
   * @returns {Promise<void>} 完成即 resolve。
   */
  function withSftp(run) {
    return new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('ssh2-transport: connection is closed'));
        return;
      }
      connection.sftp((error, sftp) => {
        if (error !== null && error !== undefined) {
          reject(error);
          return;
        }
        run(sftp)
          .then(() => resolve())
          .catch((runError) => reject(runError))
          .finally(() => {
            try {
              sftp.end();
            } catch {
              // 连接已经断了：sftp.end() 抛错无意义。
            }
          });
      });
    });
  }

  return {
    kind: 'ssh2',
    /**
     * 写键盘字节。通道尚未就绪时静默丢弃——pty 还没建起来，写了也没人要。
     * @param {Buffer|Uint8Array|string} data 原始字节。
     * @returns {void}
     */
    send(data) {
      if (disposed || stream === null || !stream.writable) return;
      try {
        stream.write(data);
      } catch {
        // 写到一半断流：让 close/error 事件收尾，这里不二次上报。
      }
    },
    /**
     * 改窗口尺寸。
     * @param {number} nextCols 列数。
     * @param {number} nextRows 行数。
     * @returns {void}
     */
    resize(nextCols, nextRows) {
      if (disposed || stream === null) return;
      try {
        stream.setWindow(nextRows, nextCols);
      } catch {
        // 同上：断流后 resize 失败无意义。
      }
    },
    /**
     * 主动关闭：先关 shell 通道再断连接。
     * @returns {void}
     */
    close() {
      if (disposed) return;
      disposed = true;
      try {
        stream?.close();
      } catch {}
      try {
        connection.end();
      } catch {}
    },
    /**
     * SFTP 上传一个本地文件。
     * @param {string} localPath 本地绝对路径（调用方已做 transferRoot 校验）。
     * @param {string} remotePath 远端路径。
     * @returns {Promise<void>} 完成即 resolve。
     */
    uploadFile(localPath, remotePath) {
      return withSftp(
        (sftp) =>
          new Promise((resolve, reject) => {
            sftp.fastPut(localPath, remotePath, (error) => (error ? reject(error) : resolve()));
          }),
      );
    },
    /**
     * SFTP 下载一个远端文件。
     * @param {string} remotePath 远端路径。
     * @param {string} localPath 本地绝对路径（调用方已做 transferRoot 校验）。
     * @returns {Promise<void>} 完成即 resolve。
     */
    downloadFile(remotePath, localPath) {
      return withSftp(
        (sftp) =>
          new Promise((resolve, reject) => {
            sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()));
          }),
      );
    },
  };
}

/**
 * 测试用 fake transport：不起网络，行为可脚本化。
 *
 * - `emit(data)` 模拟"远端来输出"——直接喂给 onData，让 service 层走真实的
 *   缓冲 / seq / 订阅路径；
 * - `sent` 记录客户端写进去的字节，供断言；
 * - `close()` 走 onExit，模拟远端关闭；
 * - `uploads` / `downloads` 记录 SFTP 调用（T04 的传输断言靠它）。
 * @param {object} config 连接配置（只读 cols/rows）。
 * @param {object} handlers 事件回调。
 * @returns {object} transport 对象。
 */
export function createFakeTransport(config = {}, handlers = {}) {
  const cols = Number.isInteger(config.cols) && config.cols > 0 ? config.cols : 80;
  const rows = Number.isInteger(config.rows) && config.rows > 0 ? config.rows : 24;
  /** @type {Buffer[]} 客户端写入的字节历史。 */
  const sent = [];
  let closed = false;

  return {
    kind: 'fake',
    sent,
    size: { cols, rows },
    /** @type {Array<{local: string, remote: string}>} 上传调用记录。 */
    uploads: [],
    /** @type {Array<{local: string, remote: string}>} 下载调用记录。 */
    downloads: [],
    /** 传输层收到的完整 config（含秘密，**只允许测试断言用**）。 */
    config,
    /**
     * 模拟远端输出。
     * @param {Buffer|Uint8Array|string} data 输出内容。
     * @returns {void}
     */
    emit(data) {
      if (closed) return;
      handlers.onData?.(data);
    },
    /**
     * 记录一次客户端写入。
     * @param {Buffer|Uint8Array|string} data 写入内容。
     * @returns {void}
     */
    send(data) {
      if (closed) return;
      sent.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
    },
    /**
     * 记录一次尺寸变更。
     * @param {number} nextCols 列数。
     * @param {number} nextRows 行数。
     * @returns {void}
     */
    resize(nextCols, nextRows) {
      if (closed) return;
      this.size.cols = nextCols;
      this.size.rows = nextRows;
    },
    /**
     * 模拟远端关闭。
     * @returns {void}
     */
    close() {
      if (closed) return;
      closed = true;
      handlers.onExit?.({ code: 0 });
    },
    /**
     * 模拟一次 SFTP 上传。
     * @param {string} localPath 本地路径。
     * @param {string} remotePath 远端路径。
     * @returns {Promise<void>} 完成即 resolve。
     */
    async uploadFile(localPath, remotePath) {
      if (closed) throw new Error('fake-transport: connection is closed');
      this.uploads.push({ local: localPath, remote: remotePath });
      // 真实现会读本地文件；fake 用 statSync 保持一致的大小语义，
      // 但文件不存在也不该让断言失败（工具层自己会先 stat）。
      try {
        statSync(localPath);
      } catch {
        // 忽略：fake 不校验本地文件是否存在。
      }
    },
    /**
     * 模拟一次 SFTP 下载。
     * @param {string} remotePath 远端路径。
     * @param {string} localPath 本地路径。
     * @returns {Promise<void>} 完成即 resolve。
     */
    async downloadFile(remotePath, localPath) {
      if (closed) throw new Error('fake-transport: connection is closed');
      this.downloads.push({ remote: remotePath, local: localPath });
    },
  };
}
