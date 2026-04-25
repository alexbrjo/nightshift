import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const projectDir = process.cwd();
const templatePath = path.join(projectDir, 'template.jinja');
const dataPath = path.join(projectDir, 'data.jsonl');

function setupFiles() {
  fs.writeFileSync(templatePath, 'Hello {{name}}', 'utf-8');
  fs.writeFileSync(dataPath, '{"name":"World"}\n', 'utf-8');
}

function cleanupFiles() {
  try { fs.unlinkSync(templatePath); } catch { /* ignore */ }
  try { fs.unlinkSync(dataPath); } catch { /* ignore */ }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  setupFiles();
});

test.afterAll(() => {
  cleanupFiles();
});

test.beforeEach(async ({ page }) => {
  setupFiles();
  await page.goto('/');
  await page.waitForLoadState('networkidle');
});

test('create a job and verify it appears in the list', async ({ page }) => {
  // Open the correct project directory so files are visible
  await page.evaluate(async (dir) => {
    await fetch('/api/project/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
  }, projectDir);

  await page.goto('/jobs');
  await page.waitForSelector('text=Create Job', { timeout: 60000 });

  // Fill the form
  await page.fill('input[required]', 'E2E Test Job');
  await page.fill('input[type="number"]', '1');

  // Select template file (second select) — Playwright auto-waits for option
  const templateSelect = page.locator('select').nth(1);
  await templateSelect.selectOption('template.jinja');

  // Select data file (third select)
  const dataSelect = page.locator('select').nth(2);
  await dataSelect.selectOption('data.jsonl');

  // Fill host and model (after the radio inputs)
  const inputs = page.locator('input');
  await inputs.nth(4).fill('http://localhost:3000');
  await inputs.nth(5).fill('gpt-4');

  // Submit
  await page.click('button:has-text("Create Job")');

  // Wait for navigation to job detail
  await page.waitForURL(/\/jobs\/.+/, { timeout: 10000 });

  // Go back to jobs list to verify it appears
  await page.goto('/jobs');
  await page.waitForSelector('text=Existing Jobs', { timeout: 10000 });
  await expect(page.locator('text=E2E Test Job').first()).toBeVisible();
});

test('open a file in the editor, type content, and verify save', async ({ page }) => {
  // Open the correct project directory
  await page.evaluate(async (dir) => {
    await fetch('/api/project/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir }),
    });
  }, projectDir);

  await page.goto('/?file=template.jinja');
  await page.waitForSelector('.monaco-editor', { timeout: 60000 });

  // Type new content into the editor
  await page.click('.monaco-editor');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Updated content');

  // Click Save button to persist changes
  await page.click('button:has-text("Save")');

  // Wait for save indicator
  await page.waitForSelector('text=Saved', { timeout: 10000 });

  // Verify the file was saved on disk
  const saved = fs.readFileSync(templatePath, 'utf-8');
  expect(saved).toBe('Updated content');
});
