import { useEffect, useState, useSyncExternalStore } from 'react';

import { statementFileGateway } from '../lib/statementFileGateway';
import { createStatementFileSelection } from './statementFileSelection';

export function useStatementFile() {
  const [selection] = useState(() => createStatementFileSelection(statementFileGateway));
  const state = useSyncExternalStore(selection.subscribe, selection.getSnapshot);

  useEffect(() => {
    selection.activate();
    return () => selection.deactivate();
  }, [selection]);

  return { ...state, pickFile: selection.pickFile, clearFile: selection.clearFile, releaseFile: selection.releaseFile };
}
