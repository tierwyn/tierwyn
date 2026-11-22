/**
 * Backwards compatibility re-export.
 * Turn info has graduated from a popover to a full-featured TurnInfoModal.
 */
export {
  TurnInfoModal as TurnInfoPopover,
  type TurnInfoModalProps as TurnInfoPopoverProps,
  summarizeToolInput,
  extractFileInfo,
  extractCommand,
  extractQuery,
  extractUrl,
} from './TurnInfoModal.js';
