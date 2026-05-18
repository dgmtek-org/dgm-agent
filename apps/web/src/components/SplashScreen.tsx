import { APP_BASE_NAME } from "../branding";

export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-28 items-center justify-center"
        aria-label={`${APP_BASE_NAME} splash screen`}
      >
        <img alt={APP_BASE_NAME} className="size-20 object-contain" src="/logo.svg" />
      </div>
    </div>
  );
}
