import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useStatementImport } from '../model/useStatementImport';
import { ImportResult } from './ImportResult';

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  const unit = bytes < 1024 * 1024 ? 'КиБ' : 'МиБ';
  const divisor = unit === 'КиБ' ? 1024 : 1024 * 1024;
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(bytes / divisor)} ${unit}`;
}

function Action({ label, hint, disabled, primary = false, destructive = false, onPress, testID }: {
  label: string;
  hint?: string;
  disabled: boolean;
  primary?: boolean;
  destructive?: boolean;
  onPress: () => void | Promise<void>;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => void onPress()}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primaryButton : styles.secondaryButton,
        destructive && styles.destructiveButton,
        pressed && styles.pressedButton,
        disabled && styles.disabledButton,
      ]}
    >
      <Text style={[
        primary ? styles.primaryButtonText : styles.secondaryButtonText,
        destructive && styles.destructiveButtonText,
      ]}>{label}</Text>
    </Pressable>
  );
}

function ErrorMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.error}>
      <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={styles.errorText}>
        {message}
      </Text>
    </View>
  );
}

function Progress({ text }: { text: string }) {
  if (!text) return null;
  return (
    <View style={styles.progress}>
      <ActivityIndicator accessible={false} color="#142437" />
      <Text accessibilityLiveRegion="polite" style={styles.progressText}>{text}</Text>
    </View>
  );
}

export function StatementImportScreen() {
  const { selection, operation, confirmUpload, retry, refresh, deleteImport, newImport, discardRejected } = useStatementImport();
  // Tie the confirmation to this operation, so it never authorizes a later one.
  const [deleteConfirmationFor, setDeleteConfirmationFor] = useState<string | null>(null);
  const { file, status, error, pickFile, clearFile } = selection;
  const isSelectionBusy = status !== 'idle';
  const isRequestBusy = ['restoring', 'saving', 'uploading', 'checking', 'deleting', 'clearing'].includes(operation.phase);
  const isOperationBusy = isRequestBusy || operation.phase === 'waiting';
  const isSelectionDisabled = isSelectionBusy || isOperationBusy || operation.storageBlocked;
  const isDeleted = operation.phase === 'deleted';
  const importStatus = operation.operation?.checkpoint?.status;
  const isRejected = operation.operation?.submission === 'rejected' && !operation.operation.checkpoint;
  const isClearingDeleted = !isDeleted && operation.operation?.checkpoint?.status === 'deleted';
  const isDeleting = !isDeleted && Boolean(
    operation.operation?.deleteKey || operation.phase === 'deleting' ||
    operation.operation?.checkpoint?.status === 'deleting' ||
    operation.operation?.checkpoint?.status === 'deleted'
  );
  const readyJob = !isDeleting && !isDeleted && operation.job?.status === 'ready' ? operation.job : null;
  const canDelete = Boolean(operation.operation?.checkpoint &&
    ['queued', 'processing', 'ready'].includes(operation.operation.checkpoint.status)) &&
    !isDeleting && !isDeleted && !operation.storageBlocked;
  const showDeleteConfirmation = canDelete && deleteConfirmationFor === operation.operation?.key;
  let operationTitle = 'Импорт выписки';
  if (isDeleting) operationTitle = operation.error ? 'Удаление не завершено' : 'Удаляем импорт';
  else if (isRejected) operationTitle = 'Файл отклонён';
  else if (readyJob) operationTitle = 'Выписка обработана';
  else if (importStatus === 'queued') operationTitle = 'Выписка в очереди';
  else if (importStatus === 'processing') operationTitle = 'Обрабатываем выписку';
  const selectedStatusText = {
    idle: '',
    picking: 'Открываем файлы…',
    validating: 'Проверяем файл…',
    clearing: 'Убираем файл…',
  }[status];
  const operationStatusText = {
    restoring: 'Восстанавливаем импорт…',
    idle: '',
    saving: isDeleting ? 'Подготавливаем удаление…' : 'Подготавливаем отправку…',
    uploading: 'Отправляем выписку…',
    checking: isDeleting ? 'Проверяем удаление…' : 'Проверяем состояние импорта…',
    waiting: isDeleting ? 'Удаляем импорт…' : importStatus === 'queued' ? 'В очереди…' : 'Обрабатываем выписку…',
    ready: '',
    deleting: 'Удаляем импорт…',
    deleted: '',
    clearing: 'Убираем файл…',
    error: '',
  }[operation.phase];

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>STATEMENT IMPORT</Text>
        <Text accessibilityRole="header" style={styles.title}>Импорт выписки</Text>
        <Text style={styles.description}>Ваши регулярные списания — в одном месте.</Text>

        {isDeleted ? (
          <View style={styles.card}>
            <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.cardTitle}>
              Импорт удалён
            </Text>
            <Text style={styles.body}>
              Сервер подтвердил удаление. Исходный файл остался на устройстве.
            </Text>
            <Action
              label="Выбрать новую выписку"
              hint="Возвращает к выбору файла для нового импорта"
              disabled={false}
              primary
              onPress={newImport}
              testID="statement-import-new"
            />
          </View>
        ) : operation.operation ? (
          <>
            <View style={styles.card}>
              <Text accessibilityRole="header" style={styles.cardTitle}>
                {operationTitle}
              </Text>
              {operation.operation.file ? (
                <View style={styles.fileDetails}>
                  <Text selectable style={styles.fileName}>{operation.operation.file.name}</Text>
                  <Text style={styles.fileMetadata}>
                    {operation.operation.file.format.toUpperCase()} · {formatFileSize(operation.operation.file.size)}
                  </Text>
                </View>
              ) : null}
              {!readyJob ? (
                <Text style={styles.body}>
                  {isDeleting
                    ? 'Дождёмся подтверждения сервера. Если закрыть приложение, проверим удаление при следующем запуске.'
                    : isRejected
                    ? 'Файл не принят сервером. Можно выбрать другую выписку.'
                    : 'После возвращения в приложение проверим состояние импорта.'}
                </Text>
              ) : null}
              <Progress text={operationStatusText} />
              <ErrorMessage message={operation.error} />
              {operation.error && (!isRejected || operation.storageBlocked) ? (
                <Action
                  label={isClearingDeleted ? 'Повторить очистку' : isDeleting ? 'Повторить удаление' : 'Повторить'}
                  hint={isClearingDeleted ? 'Повторяет очистку локальных данных уже удалённого импорта' : isDeleting
                    ? 'Проверяет состояние и при необходимости повторяет удаление'
                    : 'Сначала проверяет состояние сохранённого импорта'}
                  disabled={isOperationBusy}
                  primary
                  onPress={retry}
                  testID="statement-import-retry"
                />
              ) : null}
              {isRejected ? (
                <Action
                  label="Выбрать другой файл"
                  hint="Убирает локальную копию отклонённого файла и возвращает к выбору выписки"
                  disabled={isOperationBusy || operation.storageBlocked}
                  primary
                  onPress={discardRejected}
                  testID="statement-import-replace-rejected"
                />
              ) : null}
              {readyJob && !operation.error ? (
                <Action
                  label="Обновить статус"
                  disabled={isOperationBusy}
                  onPress={refresh}
                  testID="statement-import-refresh"
                />
              ) : null}
              {showDeleteConfirmation ? (
                <View style={styles.deleteConfirmation} testID="statement-delete-confirmation">
                  <Text accessibilityRole="header" style={styles.cardTitle}>Удалить импорт?</Text>
                  <Text style={styles.body}>
                    Импорт и его результат будут удалены с сервера. Исходный PDF или CSV останется на устройстве.
                  </Text>
                  <Action
                    label="Подтвердить удаление"
                    disabled={isRequestBusy}
                    destructive
                    onPress={async () => {
                      setDeleteConfirmationFor(null);
                      await deleteImport();
                    }}
                    testID="statement-delete-confirm"
                  />
                  <Action
                    label="Оставить импорт"
                    disabled={isRequestBusy}
                    onPress={() => setDeleteConfirmationFor(null)}
                    testID="statement-delete-cancel"
                  />
                </View>
              ) : canDelete ? (
                <Action
                  label="Удалить импорт"
                  hint="Открывает подтверждение удаления с сервера"
                  disabled={isRequestBusy}
                  destructive
                  onPress={() => setDeleteConfirmationFor(operation.operation!.key)}
                  testID="statement-import-delete"
                />
              ) : null}
            </View>
            {readyJob ? <ImportResult job={readyJob} /> : null}
          </>
        ) : (
          <View style={styles.card}>
            <Text accessibilityRole="header" style={styles.cardTitle}>
              {file ? 'Подтвердите отправку' : 'Выберите выписку'}
            </Text>
            {file ? (
              <View style={styles.fileDetails}>
                <Text selectable style={styles.fileName}>{file.name}</Text>
                <Text style={styles.fileMetadata}>
                  {file.format.toUpperCase()} · {formatFileSize(file.size)}
                </Text>
                <Text style={styles.body}>
                  Файл ещё не отправлен. После подтверждения передадим его тестовому серверу для обработки.
                </Text>
              </View>
            ) : (
              <Text style={styles.body}>
                Выберите PDF или CSV на устройстве. Максимальный размер — 10 МиБ.
              </Text>
            )}
            <ErrorMessage message={error} />
            <ErrorMessage message={operation.error} />
            <Progress text={selectedStatusText || operationStatusText} />
            {operation.error ? (
              <Action
                label="Повторить"
                disabled={isOperationBusy || isSelectionBusy}
                primary
                onPress={retry}
                testID="statement-import-retry"
              />
            ) : null}
            {file ? (
              <Action
                label="Подтвердить и отправить"
                hint="Отправляет выбранную выписку тестовому серверу"
                disabled={isSelectionDisabled}
                primary
                onPress={confirmUpload}
                testID="statement-import-confirm"
              />
            ) : null}
            <Action
              label={file ? 'Выбрать другой файл' : 'Выбрать PDF или CSV'}
              hint="Открывает системный диалог выбора одного файла"
              disabled={isSelectionDisabled}
              primary={!file}
              onPress={pickFile}
              testID="statement-file-select"
            />
            {file ? (
              <Action
                label="Убрать файл"
                hint="Отменяет выбор. Исходный файл останется на устройстве"
                disabled={isSelectionDisabled}
                onPress={clearFile}
                testID="statement-file-clear"
              />
            ) : null}
          </View>
        )}
        <Text style={styles.caption}>Только вымышленные данные из комплекта задания.</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F4F6F8' },
  content: {
    flexGrow: 1, paddingHorizontal: 20, paddingVertical: 28, gap: 16,
    width: '100%', maxWidth: 640, alignSelf: 'center',
  },
  eyebrow: { color: '#42556B', fontSize: 12, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#142437', fontSize: 34, fontWeight: '700' },
  description: { color: '#42556B', fontSize: 18, lineHeight: 27 },
  card: { marginTop: 8, padding: 20, gap: 12, borderRadius: 20, backgroundColor: '#FFFFFF' },
  cardTitle: { color: '#142437', fontSize: 22, fontWeight: '600' },
  body: { color: '#42556B', fontSize: 16, lineHeight: 25 },
  fileDetails: { gap: 8 },
  fileName: { color: '#142437', fontSize: 18, lineHeight: 27, fontWeight: '600' },
  fileMetadata: { color: '#42556B', fontSize: 15, lineHeight: 23 },
  error: { padding: 16, borderRadius: 12, backgroundColor: '#FFF0EE' },
  errorText: { color: '#9B2525', fontSize: 16, lineHeight: 24 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  progressText: { flexShrink: 1, color: '#42556B', fontSize: 16, lineHeight: 24 },
  button: {
    minHeight: 52, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 16, paddingVertical: 14, borderRadius: 14,
  },
  primaryButton: { marginTop: 4, backgroundColor: '#142437' },
  primaryButtonText: { color: '#FFFFFF', textAlign: 'center', fontSize: 16, lineHeight: 24, fontWeight: '600' },
  secondaryButton: { borderWidth: 1, borderColor: '#BCC7D2' },
  secondaryButtonText: { color: '#142437', textAlign: 'center', fontSize: 16, lineHeight: 24, fontWeight: '600' },
  destructiveButton: { borderWidth: 1, borderColor: '#B34A41', backgroundColor: '#FFF4F2' },
  destructiveButtonText: { color: '#91251D' },
  deleteConfirmation: { marginTop: 4, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#E4E9EF', gap: 12 },
  pressedButton: { opacity: 0.75 },
  disabledButton: { opacity: 0.5 },
  caption: { color: '#52657A', fontSize: 14, lineHeight: 22 },
});
