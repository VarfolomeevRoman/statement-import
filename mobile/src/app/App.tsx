import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { StatementImportScreen } from '../features/statement-import';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <StatementImportScreen />
    </SafeAreaProvider>
  );
}
