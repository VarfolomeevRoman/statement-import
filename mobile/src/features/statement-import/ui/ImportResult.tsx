import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ImportJob } from '../api/importApi';

type ReadyJob = Extract<ImportJob, { status: 'ready' }>;

function formatAmount(amountMinor: number, currency: string) {
  return `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amountMinor / 100)} ${currency}`;
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-');
  return `${day}.${month}.${year}`;
}

export function ImportResult({ job }: { job: ReadyJob }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const totalMinor = job.items.reduce((total, item) => total + item.amountMinor, 0);

  return (
    <View style={styles.results} testID="statement-import-result">
      <View style={styles.summary}>
        <Text accessibilityRole="header" style={styles.heading}>Регулярные списания</Text>
        <Text style={styles.total}>{formatAmount(totalMinor, job.currency)}</Text>
        <Text style={styles.body}>в месяц · найдено: {job.items.length}</Text>
      </View>
      {job.items.map((item) => {
        const expanded = expandedId === item.id;
        return (
          <View key={item.id} style={styles.item}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.merchant}, ${formatAmount(item.amountMinor, job.currency)} в месяц`}
              accessibilityHint={expanded ? 'Скрывает подробности списания' : 'Показывает подробности списания'}
              accessibilityState={{ expanded }}
              onPress={() => setExpandedId(expanded ? null : item.id)}
              testID={`statement-result-${item.id}`}
              style={({ pressed }) => [styles.itemButton, pressed && styles.pressed]}
            >
              <Text style={styles.merchant}>{item.merchant}</Text>
              <Text style={styles.amount}>{formatAmount(item.amountMinor, job.currency)} в месяц</Text>
              <Text style={styles.link}>{expanded ? 'Скрыть подробности ↑' : 'Подробности ↓'}</Text>
            </Pressable>
            {expanded ? (
              <View style={styles.details}>
                <Text style={styles.body}>Периодичность: ежемесячно</Text>
                <Text style={styles.body}>Последнее списание: {formatDate(item.lastSeen)}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  results: { gap: 12 },
  summary: { padding: 20, gap: 8, borderRadius: 20, backgroundColor: '#E6F1EB' },
  heading: { color: '#183D2C', fontSize: 22, fontWeight: '600' },
  total: { color: '#183D2C', fontSize: 30, fontWeight: '700' },
  body: { color: '#42556B', fontSize: 16, lineHeight: 25 },
  item: { borderRadius: 20, backgroundColor: '#FFFFFF', overflow: 'hidden' },
  itemButton: { minHeight: 52, padding: 20, gap: 6 },
  merchant: { color: '#142437', fontSize: 20, fontWeight: '600' },
  amount: { color: '#42556B', fontSize: 16, lineHeight: 25 },
  link: { color: '#254F7C', fontSize: 16, lineHeight: 25, fontWeight: '600' },
  details: { borderTopWidth: 1, borderTopColor: '#E4E9EF', padding: 20, gap: 8 },
  pressed: { opacity: 0.7 },
});
