import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";

export function ErrorBox({ error }) {
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>
        {String(error.message || error)}
        {error.status ? <div className="text-xs mt-1 opacity-70">HTTP {error.status}</div> : null}
      </AlertDescription>
    </Alert>
  );
}
