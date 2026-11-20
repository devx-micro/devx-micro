export {
  MARKER_FILENAME,
  MARKER_VERSION,
  WorkspaceError,
  type Workspace,
  type WorkspaceErrorCode,
  type WorkspaceMarker,
} from './lib/marker';
export { type ResolveOptions } from './lib/discovery';
export { migrateAppState, type MigrationResult } from './lib/migrate';
export {
  projectMarker,
  type ProjectMarker,
  type ProjectMarkerOptions,
} from './lib/project-marker';
