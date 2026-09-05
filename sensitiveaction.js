// sensitiveaction.js — decide whether a click is about to do something the user should confirm:
// pay, post, send, delete, submit, buy. Pure text/selector classification, so it is testable
// without a browser and cannot be fooled by page state.
//
// 🔴 The competitor (Aside) puts it this way: "sensitive actions like payments, posts, and
//    messages always wait for your confirmation." That is also this tool's standing rule — the
//    agent never presses send/pay/delete unattended without an explicit opt-in. This module is
//    the classifier the engine consults before such a click.
//
// Contract: classify(target) -> { sensitive: boolean, kind: string|null, reason: string }
//   target: { selector?, text?, type? }  (what the click is aiming at)
// 🔵 When in doubt it leans SENSITIVE (asking is cheap; an unwanted payment is not). A caller
//    that has an explicit opt-in for this action proceeds; otherwise it pauses for confirmation.

// Word groups by what the action does. Matched against button text and the selector.
const KINDS = [
  { kind: 'pay', words: ['pay', 'buy', 'purchase', 'checkout', 'place order', 'order now',
    'subscribe', 'donate', 'withdraw', 'transfer', 'remit', '결제', '구매', '주문', '결제하기',
    '송금', '출금', '이체', '支付', '付款', '购买', '下单', '转账', '提现', 'pagar', 'comprar', 'pedido',
    'transferir', 'retirar', 'remesa'] },
  { kind: 'send', words: ['send', 'send message', 'reply', 'post', 'publish', 'tweet', 'share',
    'comment', '보내기', '전송', '게시', '답글', '댓글', '发送', '发布', '发表', 'enviar', 'publicar'] },
  { kind: 'delete', words: ['delete', 'remove', 'erase', 'destroy', 'deactivate', 'close account',
    '삭제', '제거', '탈퇴', '删除', '移除', '注销', 'eliminar', 'borrar'] },
  { kind: 'confirm-irreversible', words: ['confirm', 'submit', 'agree', 'accept', 'authorize',
    '확인', '확정', '제출', '동의', '수락', '确认', '提交', '同意', 'confirmar', 'aceptar'] },
];

function norm(s) { return (s || '').toString().toLowerCase().trim(); }

function classify(target) {
  if (!target || typeof target !== 'object') {
    return { sensitive: false, kind: null, reason: 'no target' };
  }
  const hay = `${norm(target.text)} ${norm(target.selector)}`;
  const type = norm(target.type);

  // A submit-type control is inherently a form commit — treat as sensitive unless clearly benign.
  for (const g of KINDS) {
    const hit = g.words.find((w) => hay.includes(w));
    if (hit) {
      return { sensitive: true, kind: g.kind, reason: `matches "${hit}" (${g.kind})` };
    }
  }
  if (type === 'submit') {
    return { sensitive: true, kind: 'confirm-irreversible', reason: 'type=submit' };
  }
  return { sensitive: false, kind: null, reason: 'no sensitive signal' };
}

module.exports = { classify, KINDS };
