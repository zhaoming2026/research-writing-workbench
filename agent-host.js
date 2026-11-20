const frame = document.querySelector('#research-menu');
const menu = new URL('./agent.html', location.href);
menu.searchParams.set('host_origin', location.origin);
frame.src = menu.href;

const snippet = [
  '<iframe id="research-menu" title="科研写作功能选择"></iframe>',
  '<script>',
  '  const frame = document.querySelector("#research-menu");',
  '  const menu = new URL("https://zhaoming2026.github.io/research-writing-workbench/agent.html");',
  '  menu.searchParams.set("host_origin", location.origin);',
  '  frame.src = menu.href;',
  '  window.addEventListener("message", event => {',
  '    if (event.origin !== menu.origin || event.source !== frame.contentWindow) return;',
  '    if (event.data?.type !== "research-writing.submit") return;',
  '    // 把完整规则与所选材料交给你已有的智能体调用函数。',
  '    yourAgent.send({ message: event.data.prompt, attachments: currentAttachments });',
  '  });',
  '</script>',
].join('\n');
document.querySelector('#integration-code').textContent = snippet;
window.addEventListener('message', event => {
  if (event.origin !== menu.origin || event.source !== frame.contentWindow) return;
  const value = event.data;
  if (value?.type === 'research-writing.ready') {
    document.querySelector('#host-status').textContent = '菜单已连接，等待使用者选择功能。';
  }
  if (value?.type !== 'research-writing.submit' || value.version !== 1 || typeof value.prompt !== 'string') return;
  document.querySelector('#host-request').value = value.prompt;
  document.querySelector('#host-status').textContent = '已收到 ' + (value.request.auto ? '自动处理' : value.request.task_ids.join(' + '))
    + ' · ' + value.request.profile.field + ' · 完整请求 ' + value.prompt.length + ' 字符';
  document.dispatchEvent(new CustomEvent('research-writing:submit', { detail: value }));
});
document.querySelector('#copy-code').onclick = async () => {
  try {
    await navigator.clipboard.writeText(snippet);
    document.querySelector('#host-status').textContent = '接入代码已复制。将示例中的调用函数与你的智能体接口连接。';
  } catch {
    document.querySelector('#host-status').textContent = '可选中接入代码后复制。';
  }
};
