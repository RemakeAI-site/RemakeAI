import {expect,test} from '@playwright/test';
import {readFile} from 'node:fs/promises';

test('browser attaches, downloads and restores a publication with an original',async ({page,request,browser,baseURL})=>{
  const target = process.env.STUDIO_RESTORE_URL;
  test.skip(!target,'requires a second clean studio');
  const publication = await (await request.post('/api/publications',{data:{title:'Браузерное восстановление',description:'Проверка ZIP с оригиналом'}})).json();
  await page.goto('/publications/'+publication.id);
  await expect(page.getByLabel('Название TikTok')).toHaveValue(publication.title);
  const file = await readFile(new URL('./fixtures/media-test.mp4',import.meta.url));
  await page.getByLabel('Загрузить фотографии и видео').setInputFiles({name:'original.mp4',mimeType:'video/mp4',buffer:file});
  await expect(page.getByRole('link',{name:'Скачать original.mp4'})).toBeVisible();
  const original = await page.getByRole('link',{name:'Скачать original.mp4'}).getAttribute('href');
  const download = await page.request.get(original!);
  expect(await download.body()).toEqual(file);
  const exported = await page.request.get('/api/export');
  expect(exported.ok()).toBeTruthy();
  const restore = await browser.newPage({baseURL:target ?? baseURL});
  try {
    await restore.goto('/backup');
    await restore.getByLabel('Файл резервной копии').setInputFiles({name:'studio.zip',mimeType:'application/zip',buffer:await exported.body()});
    await restore.getByRole('button',{name:'Восстановить из ZIP'}).click();
    await restore.getByRole('dialog').getByRole('button',{name:'Восстановить',exact:true}).click();
    await expect(restore.getByText('Данные и оригиналы восстановлены.')).toBeVisible();
    const copy = await restore.request.get('/api/publications/'+publication.id);
    const restored = await copy.json();
    expect(restored.description).toBe(publication.description);
    const restoredFile = await restore.request.get('/api/media/'+restored.media[0].id+'?download=1');
    expect(await restoredFile.body()).toEqual(file);
  } finally { await restore.close(); }
});
