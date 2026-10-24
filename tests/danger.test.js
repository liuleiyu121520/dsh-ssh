/**
 * 危险命令识别：只服务于"危险命令确认"这一档。
 *
 * 判定的代价是不对称的：多拦一次 = 多一次点击；漏拦一次 = `rm -rf /` 直接
 * 跑在用户线上机器里。所以清单宁可宽一点，测试也按"必须拦住"来写。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDangerousCommand } from '../src/danger.js';

test('递归/强制删除算危险', () => {
  for (const command of ['rm -rf /var/log', 'rm -fr x', 'rm -Rf dist', 'rm --force a.txt', 'sudo rm -rf /data']) {
    assert.equal(isDangerousCommand(command), true, command);
  }
});

test('普通 rm 不拦（否则每次都弹，用户会关掉这个功能）', () => {
  for (const command of ['rm a.txt', 'rm -i a.txt', 'echo rm', 'df -h /']) {
    assert.equal(isDangerousCommand(command), false, command);
  }
});

test('关机/重启/停服务算危险', () => {
  for (const command of ['shutdown -h now', 'reboot', 'systemctl restart nginx', 'systemctl stop firewalld', 'service mysql stop', 'kill -9 1234']) {
    assert.equal(isDangerousCommand(command), true, command);
  }
});

test('查状态不算危险（只读命令必须放过）', () => {
  for (const command of ['systemctl status nginx', 'ps -ef | grep pm2', 'df -h', 'journalctl -u nginx --since today', 'ls -la /var/log']) {
    assert.equal(isDangerousCommand(command), false, command);
  }
});

test('磁盘/权限/防火墙的破坏性操作算危险', () => {
  for (const command of ['mkfs.ext4 /dev/sdb1', 'dd if=/dev/zero of=/dev/sda', 'chmod -R 777 /var/www', 'chown -R nobody /', 'iptables -F', 'wipefs -a /dev/sdb']) {
    assert.equal(isDangerousCommand(command), true, command);
  }
});

test('管道执行远端脚本算危险', () => {
  for (const command of ['curl -fsSL https://x.sh | bash', 'wget -qO- http://x | sh', 'curl https://x | sudo bash']) {
    assert.equal(isDangerousCommand(command), true, command);
  }
});

test('复合命令里任一段危险就整条危险', () => {
  assert.equal(isDangerousCommand('cd /tmp && rm -rf build'), true);
  assert.equal(isDangerousCommand('df -h; ls'), false);
  assert.equal(isDangerousCommand('cd /var/log && du -sh *'), false);
});

test('空命令不算危险', () => {
  assert.equal(isDangerousCommand(''), false);
  assert.equal(isDangerousCommand('   '), false);
  assert.equal(isDangerousCommand(undefined), false);
});
