# Запуск Android и устранение ошибок

Команды ниже выполняются из корня репозитория. Нативный Android-проект находится в `mobile/android`.

## Android Studio не находит Node

При синхронизации Gradle может появиться ошибка:

```text
A problem occurred starting process 'command 'node''
Cannot run program "node": error=2, No such file or directory
```

Это означает, что процесс сборки не смог найти Node по своему пути поиска. Успешный `node --version` в терминале не гарантирует, что окружение Android Studio совпадает с окружением терминала. Для приложений, запущенных через GUI на macOS, такое различие описано в [документации JetBrains](https://intellij-support.jetbrains.com/hc/en-us/articles/38172184112914-Command-not-found-when-running-scripts).

В локальном случае Node установлен в `/usr/local/bin/node`. Логи Android Studio показывают успешную загрузку shell environment, однако Gradle daemon на JBR 21 не смог запустить `node`. Возможное объяснение — сохранённый JVM путь поиска программ при запуске daemon; передача обновлённых переменных окружения не всегда меняет этот путь. Этот механизм описан в [Gradle issue #10483](https://github.com/gradle/gradle/issues/10483).

Для запуска IDE с окружением текущего Node используйте:

```bash
npm run android:studio
```

Перед командой **полностью завершите Android Studio через Quit / Cmd+Q**. Закрытия окна проекта недостаточно: уже работающий процесс сохраняет своё окружение.

Команда запускает `/Applications/Android Studio.app/Contents/MacOS/studio`, открывает `mobile/android` и добавляет каталог исполняемого Node первым в PATH дочернего процесса. Она не меняет системный PATH, shell-конфиги или сгенерированные Gradle-файлы. Команда предназначена для macOS и ожидает Android Studio в `/Applications`.

Если старый Gradle daemon продолжает воспроизводить ошибку, остановите его перед повторным запуском IDE. Делайте это **только когда нет выполняющихся Gradle-сборок**:

```bash
(cd mobile/android && ./gradlew --stop)
npm run android:studio
```

`--stop` останавливает daemon-процессы данной версии Gradle и может затронуть другие проекты, использующие эту версию. Сам launcher daemon-процессы не останавливает.

## Совместимость Android Studio и AGP

Проект использует Android Gradle Plugin 9.2.1 и Gradle Wrapper 9.4.1. Для AGP 9.2 нужна Android Studio **Panda 4 | 2025.3.4 или более новая совместимая версия**. Установленная при диагностике Panda 1 | 2025.3.1 поддерживает AGP только до 9.0. Версии проверены по [официальной таблице совместимости Google](https://developer.android.com/build/releases/about-agp).

Локально Android Studio обновлена до **Rabbit 2 | 2026.2.2**, build `AI-262.10968.63.2622.16730706`, и установлена в `/Applications/Android Studio.app`. На другой машине перед синхронизацией также нужна совместимая версия IDE. Launcher передаёт PATH, а поддержка AGP определяется версией Android Studio. Версии сборочных инструментов проекта задаются зависимостями Expo/React Native; изменение generated Gradle-файлов вручную не является постоянной настройкой.

## Подключение установленного приложения к Metro

Если development build уже установлен, повторная нативная сборка для изменения TypeScript не нужна. Запустите Metro в отдельном терминале:

```bash
npm --prefix mobile run start -- --localhost --port 8081
```

Если Metro этого проекта уже работает на порту 8081, используйте его. После запуска Android-эмулятора настройте перенаправление порта:

```bash
adb devices
adb reverse tcp:8081 tcp:8081
```

В development client подключитесь к `http://127.0.0.1:8081`. Перенаправление позволяет приложению обращаться к Metro на Mac через localhost устройства; после перезапуска эмулятора его может потребоваться повторить. Если `adb` не находится в PATH, используйте `~/Library/Android/sdk/platform-tools/adb` при стандартной установке SDK на macOS.

Команды выше предполагают одно подключённое Android-устройство. Если устройств несколько, укажите выбранный идентификатор из `adb devices` через `adb -s <device-id> reverse tcp:8081 tcp:8081`.

Для работы с mock-сервером нужен отдельный проброс `adb reverse tcp:8787 tcp:8787`. Доступность Metro не подтверждает доступность API или реализацию импорта.

## Что проверено

1 ноября 2026 года CLI-сборка Android для `arm64-v8a` на JBR 21 с правильным PATH и `--no-daemon` завершилась сообщением `BUILD SUCCESSFUL`. Development build установлен и запущен на Pixel 7 Pro Emulator, Android 17 / API 37. Экран «Импорт выписки» проверен визуально.

После полного завершения старой IDE и запуска Rabbit 2 через `npm run android:studio` синхронизация Gradle завершилась успешно 1 ноября 2026 года в 13:32:50 по местному времени, за 3 мин 44 с. В `idea.log` зафиксированы `onSuccess`, `onImportFinished` и `Gradle sync finished`; в интерфейсе доступна команда Run `app`, выбран Pixel 7 Pro. Для этой синхронизации автоматически использовался Temurin 21.0.7 из `~/.gradle/jdks`.

Ошибка поиска Node устранена при проверенном запуске через project launcher. Запуск IDE из Dock отдельно не проверялся. Полный сценарий импорта реализован. Кандидат подтвердил ручной прогон и запись видео Android 2026-11-03; видео предоставляет отдельно. Инструментально подтверждены сборка, запуск, восстановление по ключу и очистка; отдельные сценарии сбоев Android и их счётчики инструментально не зафиксированы. Фактические результаты платформ приведены в README и матрице приёмки.
