import { Skeleton } from "@/components/ui/skeleton";

export function Loading({ label = "Loading…" }) {
  return (
    <div className="flex flex-col gap-2 p-4" aria-label={label}>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}
