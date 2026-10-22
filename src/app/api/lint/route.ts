import { lintPackage, toMarkdown, toSarif } from "@/lib/linter";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * POST /api/lint — lint a CPI package for CI pipelines.
 *
 *   curl -F file=@MyPackage.zip http://localhost:3000/api/lint
 *   curl --data-binary @MyPackage.zip -H "Content-Type: application/zip" "http://localhost:3000/api/lint?name=MyPackage.zip&format=sarif"
 *
 * Query: `format=json|sarif|md` (default json).
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const format = url.searchParams.get("format") ?? "json";

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) return error(413, `Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

  let bytes: Uint8Array;
  let fileName: string;
  try {
    if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return error(400, 'Send the package as multipart field "file".');
      bytes = new Uint8Array(await file.arrayBuffer());
      fileName = file.name || "package.zip";
    } else {
      bytes = new Uint8Array(await request.arrayBuffer());
      fileName = url.searchParams.get("name") ?? "package.zip";
    }
  } catch {
    return error(400, "Could not read the request body.");
  }

  if (bytes.byteLength === 0) return error(400, "Empty upload.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return error(413, `Upload exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

  try {
    const report = await lintPackage(bytes, fileName);
    if (format === "sarif") return Response.json(toSarif(report), { headers: { "Content-Type": "application/sarif+json" } });
    if (format === "md") return new Response(toMarkdown(report), { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    return Response.json(report);
  } catch (e) {
    return error(422, (e as Error).message);
  }
}

function error(status: number, message: string) {
  return Response.json({ error: message }, { status });
}
