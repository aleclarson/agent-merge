declare module 'fs-native-extensions' {
  export function tryLock(fileDescriptor: number): boolean
  export function waitForLock(fileDescriptor: number): Promise<void>
  export function unlock(fileDescriptor: number): void
}
