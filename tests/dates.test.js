import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatDate,parseDate,todayLocal} from '../src/dates.js';
test('dates always display day/month/year without UTC date shift',()=>{assert.equal(formatDate('2026-09-14'),'14/09/2026');assert.equal(formatDate('1992-06-12'),'12/06/1992');assert.equal(formatDate('2026-01-01T00:00:00.000Z'),'01/01/2026');assert.equal(formatDate(null),'—');});
test('day/month parsing supports Arabic digits and validates leap years',()=>{assert.equal(parseDate('١٤/٠٩/٢٠٢٦'),'2026-09-14');assert.equal(parseDate('۱۴/۰۹/۲۰۲۶'),'2026-09-14');assert.equal(parseDate('1/2/2026'),'2026-02-01');assert.equal(parseDate('29/02/2024'),'2024-02-29');assert.equal(parseDate('29/02/2025'),null);assert.equal(parseDate('31/04/2026'),null);assert.equal(parseDate('09/14/2026'),null);assert.equal(parseDate('2026-09-14'),null);assert.match(todayLocal(),/^\d{4}-\d{2}-\d{2}$/);});
