import type { Commands } from '../commandSet';
import type { SecurityPanel } from './security';

/** The Security panel's command (BL-271). */
export function securityCommands(deps: { security: SecurityPanel }): Commands {
  return {
    'flotilla.openSecurity': () => deps.security.open(),
  };
}
