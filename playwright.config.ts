import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
const system = '/usr/bin/chromium';
const executablePath = process.env.STUDIO_CHROMIUM_PATH ?? (existsSync(system) ? system : undefined);
export default defineConfig({
  testDir:'tests',
  testMatch:'**/*.spec.ts',
  fullyParallel:false,
  workers:1,
  timeout:45_000,
  use:{
    baseURL:process.env.STUDIO_TEST_URL ?? 'http://127.0.0.1:8787',
    launchOptions:{executablePath},
    trace:'retain-on-failure',
    screenshot:'only-on-failure'
  }
});
