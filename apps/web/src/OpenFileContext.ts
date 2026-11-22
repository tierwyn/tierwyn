import { createContext, useContext } from 'react';

export type OpenFileHandler = (path: string, gallery?: string[]) => void;

export const OpenFileContext = createContext<OpenFileHandler | undefined>(undefined);

export function useOpenFile(): OpenFileHandler | undefined {
  return useContext(OpenFileContext);
}
