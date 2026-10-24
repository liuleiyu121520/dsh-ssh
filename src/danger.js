/**
 * 危险命令识别：只服务于"危险命令确认"这一档授权。
 *
 * 设计取舍：**宁可多拦，不可漏拦**。误判的代价只是多一次点击；漏判的代价
 * 是 `rm -rf /` 直接跑在用户的线上机器里。所以这里是"模式清单 + 兜底规则"，
 * 而不是试图做一个完整的 shell 语义分析（那不可能做对）。
 *
 * 只做字符串层面的判断：模型给出的是单行命令，能覆盖绝大多数真实场景。
 * 命中后由 Host 暂停回合、让客户端出命令卡等用户确认（与"每条确认"同一套
 * 暂停/续跑机制），所以这里返回布尔值就够了。
 */

/** 明显破坏性的命令模式。 */
const PATTERNS = [
  // 递归/强制删除（`rm -rf` / `rm -f` / `rm -Rf`；不带 flag 的 rm 不算）
  /\brm\s+--(force|recursive)\b/,
  /\brm\s+-[a-zA-Z]*[rfRF][a-zA-Z]*\b/,
  // 格式化/写裸设备
  /\bmkfs(\.[a-z0-9]+)?\b/,
  /\bdd\b[^|;]*\bof=\s*\/dev\//,
  /\bwipefs\b/,
  // 关机/重启
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\binit\s+[06]\b/,
  /\bsystemctl\s+(poweroff|reboot|halt|rescue|emergency)\b/,
  // 停服务（线上最常见的事故来源）
  /\bsystemctl\s+(stop|restart|disable|mask)\b/,
  /\bservice\s+\S+\s+(stop|restart)\b/,
  /\bkill(all)?\s+-9\b/,
  // 权限/属主批量变更
  /\bchmod\s+(-[a-zA-Z]+\s+)*[0-7]{3,4}\s+\//,
  /\bchmod\s+-R\b/,
  /\bchown\s+-R\b/,
  // 防火墙清空
  /\biptables\s+(-F|--flush)\b/,
  /\bnft\s+flush\b/,
  // 容器/镜像删除
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/,
  /\bdocker-compose\s+down\b/,
  /\bkubectl\s+delete\b/,
  // 清空文件/写系统目录
  /\btruncate\s+-s\s*0\b/,
  />\s*\/etc\//,
  /\btee\s+\/etc\//,
  // 覆盖式危险重定向
  /\bmv\s+\S+\s+\/dev\/null\b/,
  // 管道执行远端脚本
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/,
  // 版本库毁坏性操作
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/,
  /\bfind\b[^|;]*-delete\b/,
  // 账号/计划任务
  /\b(userdel|groupdel)\b/,
  /\bcrontab\s+-r\b/,
  /\bpasswd\b/,
];

/**
 * 判断一条命令是否属于"需要人工确认"的危险操作。
 * @param {string} command 模型给出的单行命令。
 * @returns {boolean} 危险返回 true。
 */
export function isDangerousCommand(command) {
  const text = String(command ?? '').trim();
  if (text === '') return false;
  // 分号/&&/|| 串起来的复合命令逐段判断，任一段危险即整条危险。
  const segments = text.split(/;|&&|\|\||\n/);
  return segments.some((segment) => {
    const part = segment.trim();
    if (part === '') return false;
    return PATTERNS.some((pattern) => pattern.test(part));
  });
}
