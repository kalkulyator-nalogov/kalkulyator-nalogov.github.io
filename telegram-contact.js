/* Черновик доступен в HTML и по ссылке даже без JavaScript. */
'use strict';
document.querySelectorAll('.tg-first-message').forEach(section => {
  const button = section.querySelector('[data-tg-copy]');
  const draft = section.querySelector('[data-tg-draft]');
  const status = section.querySelector('.tg-copy-status');
  if (!button || !draft || !status || !navigator.clipboard || !navigator.clipboard.writeText) return;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(draft.textContent);
      status.textContent = 'Текст скопирован. Вставьте его в Telegram и допишите свой вопрос.';
    } catch {
      status.textContent = 'Браузер не разрешил копирование. Выделите и скопируйте текст выше вручную.';
    }
  });
});
