/** The Security panel (BL-271): the policy sandboxed agents run under, as the host reads it and the webview edits it. */
import type {
  FixedFileRule,
  PolicyScope,
  RuleError,
  SecurityPolicy,
} from '../features/sandbox/policy';

export type {
  FileAccess,
  FixedFileRule,
  PolicyScope,
  PolicySection,
  RuleError,
  SecurityPolicy,
} from '../features/sandbox/policy';

export interface SecurityView {
  /** flotilla.agents.sandbox: with none, the policy applies once it's on. */
  sandbox: 'none' | 'openshell';
  scope: PolicyScope;
  /** Whether this repository can have a policy of its own (VS Code gave the workspace storage). */
  canScopeRepository: boolean;
  /** The file the policy in force saves to, and whether it has been saved or is the default. */
  file: string;
  saved: boolean;
  policy: SecurityPolicy;
  /** Reset's policy: Flotilla's strict default for this repository. */
  defaults: SecurityPolicy;
  fixed: FixedFileRule[];
  /** What the last save did ("Saved. …"). */
  status?: string;
}

export type SecurityHostMessage =
  | { type: 'securityView'; view: SecurityView }
  /** A save that was refused, by Flotilla's checks or OpenShell's: the draft stays, the errors show at their rules. */
  | { type: 'securityErrors'; errors: RuleError[] };

export type SecurityWebviewMessage =
  | { type: 'securityReady' }
  | { type: 'securitySave'; policy: SecurityPolicy }
  | { type: 'securityScope'; scope: PolicyScope }
  | { type: 'securityEnableSandbox' };
