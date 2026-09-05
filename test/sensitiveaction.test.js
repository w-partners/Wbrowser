// The sensitive-action classifier. What it flags is what the engine pauses for confirmation on,
// so the misses (a "Pay" button read as benign) are the dangerous case — tested directly.

const { test } = require('node:test');
const assert = require('node:assert');

const { classify } = require('../sensitiveaction.js');

test('a pay / buy button is sensitive', () => {
  for (const text of ['Pay now', 'Buy', 'Place order', 'Checkout', 'Subscribe']) {
    const r = classify({ text });
    assert.ok(r.sensitive, `"${text}" was not flagged`);
    assert.equal(r.kind, 'pay');
  }
});

test('send / post / reply is sensitive', () => {
  for (const text of ['Send', 'Post', 'Reply', 'Publish', 'Tweet']) {
    assert.ok(classify({ text }).sensitive, `"${text}" was not flagged`);
  }
});

test('delete is sensitive', () => {
  assert.equal(classify({ text: 'Delete account' }).kind, 'delete');
});

test('a type=submit control is sensitive even with neutral text', () => {
  const r = classify({ text: 'Continue', type: 'submit' });
  assert.ok(r.sensitive);
  assert.equal(r.kind, 'confirm-irreversible');
});

test('sensitivity is caught in other languages', () => {
  assert.ok(classify({ text: '결제하기' }).sensitive);   // ko: pay
  assert.ok(classify({ text: '发送' }).sensitive);        // zh: send
  assert.ok(classify({ text: 'eliminar' }).sensitive);    // es: delete
});

test('a plainly benign click is not sensitive', () => {
  for (const text of ['Read more', 'Next page', 'Show details', 'Expand']) {
    assert.ok(!classify({ text }).sensitive, `"${text}" was over-flagged`);
  }
});

test('the selector is considered too, not just the text', () => {
  assert.ok(classify({ selector: 'button#delete-account', text: '' }).sensitive);
});

test('a non-object target does not crash', () => {
  assert.equal(classify(null).sensitive, false);
});

test('covers every keyword the cron RISKY gate used to catch (no gate weakening)', () => {
  // 🔴 cron.js now delegates its unattended risk gate to classify(). If classify ever stops
  //    flagging one of these, an unattended job would silently be allowed to pay/withdraw/
  //    delete. This is the exact list the old regex caught — it must keep being caught.
  const RISKY_TERMS = [
    'submit', 'purchase', 'checkout', 'payment', 'pay', 'delete', 'remove', 'withdraw',
    'transfer', 'confirm',
    '결제', '구매', '결제하기', '삭제', '제출', '확정', '송금', '출금', '주문',
    '支付', '付款', '购买', '删除', '提交', '确认', '转账', '提现', '下单',
    'pagar', 'comprar', 'eliminar', 'borrar', 'enviar', 'confirmar', 'transferir', 'retirar', 'pedido',
  ];
  const missed = RISKY_TERMS.filter((w) => !classify({ text: w }).sensitive);
  assert.deepEqual(missed, [], `these no longer trip the gate: ${missed.join(', ')}`);
});
