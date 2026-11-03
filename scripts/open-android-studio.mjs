import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Команда android:studio предназначена для macOS. Откройте mobile/android в Android Studio вручную.');
  }

  const studio = '/Applications/Android Studio.app/Contents/MacOS/studio';
  const project = fileURLToPath(new URL('../mobile/android', import.meta.url));

  try {
    await access(studio, constants.X_OK);
  } catch {
    throw new Error('Android Studio не найден в /Applications/Android Studio.app. Установите приложение в /Applications.');
  }

  try {
    await access(new URL('../mobile/android/settings.gradle', import.meta.url));
  } catch {
    throw new Error('Нативный Android-проект отсутствует. Сначала выполните npm run prebuild -- --platform android.');
  }

  const nodeDirectory = dirname(process.execPath);
  const pathEntries = [nodeDirectory, ...(process.env.PATH ?? '').split(delimiter)].filter(Boolean);
  const child = spawn(studio, [project], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PATH: [...new Set(pathEntries)].join(delimiter) },
  });

  child.once('error', (error) => {
    console.error(`Не удалось запустить Android Studio: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('spawn', () => {
    child.unref();
    console.log(`Android Studio запускается с Node из ${nodeDirectory}.`);
    console.log('Если IDE уже была открыта, полностью завершите её через Quit и повторите команду.');
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
