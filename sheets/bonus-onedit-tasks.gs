/**
 * БОНУС для «Магнат · Задачи»: автопростановка даты закрытия.
 *
 * Что делает: поставил галочку ✓ в колонке A — в колонке «Закрыта»
 * сама появляется сегодняшняя дата (снял галочку — дата стирается).
 * Больше ничего вручную вводить не нужно: графики скорости и «% в срок»
 * оживают от одной галочки.
 *
 * Как подключить (один раз, в файл «Магнат · Задачи» для покупателя):
 *  1. Откройте таблицу «Магнат · Задачи» → меню «Расширения» →
 *     «Apps Script».
 *  2. Вставьте этот файл целиком вместо содержимого Code.gs, сохраните.
 *  3. Всё. Простой триггер onEdit не требует разрешений и НАСЛЕДУЕТСЯ
 *     копиями: у покупателя после «Файл → Создать копию» тоже работает.
 */

function onEdit(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  var name = sh.getName();
  if (name !== '🎯 Задачи' && name !== '📁 Архив') return;
  if (e.range.getColumn() !== 1 || e.range.getRow() < 2) return;
  if (e.range.getNumRows() !== 1 || e.range.getNumColumns() !== 1) return;

  var row = e.range.getRow();
  var closedCell = sh.getRange(row, 7); // колонка «Закрыта»
  if (e.range.getValue() === true) {
    if (!closedCell.getValue()) closedCell.setValue(new Date());
  } else {
    closedCell.clearContent();
  }
}
