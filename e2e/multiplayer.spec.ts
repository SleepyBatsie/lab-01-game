import { test, expect } from '@playwright/test';

test('two browsers in same room see movement and receive chat messages', async ({ browser }) => {
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const page1 = await ctx1.newPage();
  const page2 = await ctx2.newPage();

  const roomName = `e2e_${Date.now()}`;

  await page1.goto('/');
  await page1.fill('#nickname-input', 'PlayerOne');
  await page1.fill('#room-input', roomName);
  await page1.click('#join-btn');
  await expect(page1.locator('#room-view')).toBeVisible();

  await page2.goto('/');
  await page2.fill('#nickname-input', 'PlayerTwo');
  await page2.fill('#room-input', roomName);
  await page2.click('#join-btn');
  await expect(page2.locator('#room-view')).toBeVisible();

  await expect(page1.locator('#players-list')).toContainText('PlayerTwo');
  await expect(page2.locator('#players-list')).toContainText('PlayerOne');

  await page1.keyboard.down('ArrowUp');
  await page1.keyboard.down('Space');
  await page1.waitForTimeout(400);
  await page1.keyboard.up('ArrowUp');
  await page1.keyboard.up('Space');

  const rxBytes = Number(await page2.locator('#ng-rx').innerText());
  expect(rxBytes).toBeGreaterThan(0);

  await page1.fill('#chat-input', 'Hello from Playwright!');
  await page1.click('#chat-form button[type="submit"]');
  await expect(page2.locator('#chat-messages')).toContainText('PlayerOne: Hello from Playwright!');

  await ctx1.close();
  await ctx2.close();
});