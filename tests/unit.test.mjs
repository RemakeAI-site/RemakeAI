import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

test('SQL seed is idempotent, preserves user edits and seeds only official rubrics', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../database/migrations/0001_studio.sql', import.meta.url), 'utf8'));
  const seed = readFileSync(new URL('../database/seeds/initial.sql', import.meta.url), 'utf8');
  db.exec(seed);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, 11);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM publications').get().n, 0);
  db.exec("UPDATE categories SET name='Переименовано' WHERE id='archive-17'; DELETE FROM categories WHERE id='imagine'");
  db.exec(seed);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM categories').get().n, 10);
  assert.equal(db.prepare("SELECT name FROM categories WHERE id='archive-17'").get().name, 'Переименовано');
  db.close();
});

test('database rejects cyclic category links', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../database/migrations/0001_studio.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../database/seeds/initial.sql', import.meta.url), 'utf8'));
  db.exec("UPDATE categories SET parent_id='archive-17' WHERE id='imagine'");
  assert.throws(() => db.exec("UPDATE categories SET parent_id='imagine' WHERE id='archive-17'"), /cycle/);
  db.close();
});
