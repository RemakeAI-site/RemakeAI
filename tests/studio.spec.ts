import {expect,test} from '@playwright/test';

test('the empty studio shows 11 real categories and creates a nested category',async ({page,request})=>{
  const initial = await (await request.get('/api/stats')).json();
  expect(initial.categories).toBeGreaterThanOrEqual(11);
  await page.goto('/');
  await expect(page.getByRole('heading',{level:1})).toBeVisible();
  await page.goto('/categories/new');
  await page.getByLabel('Название рубрики').fill('Рубрика для браузерного теста');
  await page.getByLabel('Родительская рубрика').selectOption('archive-17');
  await page.getByRole('button',{name:'Создать рубрику',exact:true}).click();
  await expect.poll(async ()=>(await (await request.get('/api/categories')).json()).some((row:{name:string;parent_id:string})=>row.name==='Рубрика для браузерного теста'&&row.parent_id==='archive-17')).toBe(true);
  await page.reload();
  await expect(page.getByText('Рубрика для браузерного теста',{exact:true}).first()).toBeVisible();
});

test('two browser sessions receive newly created and updated publications',async ({browser,request})=>{
  const first = await browser.newContext();
  const second = await browser.newContext();
  try {
    const a = await first.newPage();
    const b = await second.newPage();
    await Promise.all([a.goto('/publications'),b.goto('/publications')]);
    const title='Совместная публикация браузерного теста';
    const created=await a.request.post('/api/publications',{data:{title,description:'Две независимые сессии',status_id:'ready'}});
    expect(created.ok(),await created.text()).toBeTruthy();
    await expect(b.getByText(title,{exact:true})).toBeVisible({timeout:12000});
    const publication=await created.json();
    const updated=await b.request.patch('/api/publications/'+publication.id,{data:{version:publication.version,status_id:'published'}});
    expect(updated.ok(),await updated.text()).toBeTruthy();
    await expect(a.getByText('Опубликовано',{exact:true}).last()).toBeVisible({timeout:12000});
    expect((await (await request.get('/api/publications/'+publication.id)).json()).status_id).toBe('published');
  } finally { await first.close(); await second.close(); }
});

test('studio routes fit all specified viewport widths and report offline mode',async ({page,context})=>{
  const sizes=[320,360,390,430,768,1024,1280,1440,1920];
  for (const width of sizes) {
    await page.setViewportSize({width,height:900});
    for (const path of ['/','/categories','/publications','/ideas','/settings']) {
      await page.goto(path);
      await expect(page.getByRole('heading',{level:1})).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth),width+' '+path).toBeLessThanOrEqual(width);
    }
  }
  await context.setOffline(true);
  await expect(page.getByText(/Нет соединения|Нет интернета|Нет подключения/i).first()).toBeVisible();
});
