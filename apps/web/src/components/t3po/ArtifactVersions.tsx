import { useState } from "react";
import { T, useGT } from "gt-react";
import type { ArtifactPage, ArtifactVersion } from "@t3tools/contracts";
import { selectedArtifactPaths } from "@t3tools/client-runtime/state/t3poArtifacts";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
export function ArtifactVersions({
  page,
  busy,
  canSave,
  error,
  onSave,
  onFile,
  onPage,
}: {
  page: ArtifactPage | undefined;
  busy: boolean;
  canSave: boolean;
  error?: string;
  onSave: (paths: readonly string[]) => void;
  onFile: (version: ArtifactVersion, path: string) => void;
  onPage: (before?: number) => void;
}) {
  const gt = useGT();
  const [paths, setPaths] = useState("");
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">
        <T>Saved versions</T>
      </h3>
      <p className="text-sm text-muted-foreground">
        <T>
          Save this result with selected workspace files. Enter one relative path per line. Files
          are copied as they are now; only include files you want to keep.
        </T>
      </p>
      <Textarea
        aria-label={gt("Selected file paths")}
        value={paths}
        onChange={(event) => setPaths(event.target.value)}
      />
      <Button
        size="sm"
        disabled={!canSave || busy}
        onClick={() => onSave(selectedArtifactPaths(paths))}
      >
        <T>Save version</T>
      </Button>
      {error ? <p role="alert">{error}</p> : null}
      {page?.versions.map((version) => (
        <div key={version.id} className="space-y-1 text-sm">
          <p>{version.savedAt}</p>
          <p className="whitespace-pre-wrap">{version.result.text}</p>
          {version.files.map((file) => (
            <div key={file.path}>
              <Button variant="link" size="sm" onClick={() => onFile(version, file.path)}>
                {file.path}
              </Button>
            </div>
          ))}
        </div>
      ))}
      {page ? (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => onPage()}>
            <T>Latest</T>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={page.nextCursor === null || busy}
            onClick={() => {
              if (page.nextCursor !== null) onPage(page.nextCursor);
            }}
          >
            <T>Older versions</T>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
