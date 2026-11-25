/**
 * The editor's part of the app, as one file to fetch: the editor itself, and the two things the list of blueprints
 * borrows from it once it has arrived (the import dialog, and the Terraform writer behind its sample panel).
 *
 * Everything is reached through this one module on purpose. A bundler gives each module that is fetched on demand
 * a file of its own; fetched through here, the dialogs and the Terraform code travel inside the editor's file, and
 * opening a blueprint is one request, not four.
 */
export { Editor } from './Editor'
export { ImportDialog } from './Dialogs'
export { exportTerraform } from '../core/terraform'
