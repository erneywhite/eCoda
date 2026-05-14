export {}

declare global {
  interface Window {
    api: Record<string, never>
  }
}
