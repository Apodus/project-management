import { useState } from "react";
import { Database, HardDrive } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { backupDatabase, type BackupResult } from "@/lib/api";

export function BackupPage() {
  const [backing, setBacking] = useState(false);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleBackup() {
    setBacking(true);
    setError(null);
    setResult(null);

    try {
      const data = await backupDatabase();
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setBacking(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Database className="size-6 text-muted-foreground" />
        <h1 className="text-2xl font-bold tracking-tight">
          Database Backup
        </h1>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="size-5" />
            Create Backup
          </CardTitle>
          <CardDescription>
            Create a snapshot of the SQLite database file. Backups are stored
            in the server's data/backups directory.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={handleBackup} disabled={backing}>
            {backing ? "Creating backup..." : "Backup Database"}
          </Button>

          {result && (
            <div className="rounded-md border bg-muted/50 p-4 text-sm">
              <p className="font-medium text-green-700 dark:text-green-400">
                Backup created successfully
              </p>
              <dl className="mt-2 space-y-1 text-muted-foreground">
                <div className="flex gap-2">
                  <dt className="font-medium">Path:</dt>
                  <dd className="font-mono text-xs">{result.path}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium">Size:</dt>
                  <dd>{formatBytes(result.size)}</dd>
                </div>
                <div className="flex gap-2">
                  <dt className="font-medium">Time:</dt>
                  <dd>{new Date(result.timestamp).toLocaleString()}</dd>
                </div>
              </dl>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
