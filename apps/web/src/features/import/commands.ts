import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Command } from '../../command/commands.ts';

/*
 * Palette command for the import wizard, shaped to the existing `Command`
 * contract and reusing the Actions group. Wire at merge exactly like the other
 * feature commands (see routeWiring):
 *
 *   const staticCommands = [...useStaticCommands(onClose), ...useImportCommands(onClose)];
 *
 * Must run within a Router (for navigate), which already wraps the palette.
 */
export function useImportCommands(onRun: () => void): Command[] {
  const navigate = useNavigate();
  return useMemo<Command[]>(
    () => [
      {
        id: 'import:leads-csv',
        title: 'Import leads from CSV',
        group: 'Actions',
        keywords: ['import', 'csv', 'upload', 'leads', 'bulk', 'spreadsheet', 'contacts'],
        run: () => {
          navigate('/import');
          onRun();
        },
      },
    ],
    [navigate, onRun],
  );
}
