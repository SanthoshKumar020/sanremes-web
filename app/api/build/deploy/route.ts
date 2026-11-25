// POST /api/build/deploy — deploy a built static site to Vercel.
//
// The Vercel token comes from the user (pasted in the Website Builder form,
// stored only in their browser). It is sent here only to call Vercel's API —
// it is never stored or logged server-side. Deployment happens only after
// the human approves the preview.

import { NextRequest, NextResponse } from "next/server";
import { validateFiles } from "@/lib/build";

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Vercel project names: lowercase letters, digits, hyphens. */
function sanitizeProjectName(raw: string): string | null {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (name.length < 1) return null;
  return name;
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!isRecord(body)) {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const token =
    typeof body.vercelToken === "string" ? body.vercelToken.trim() : "";
  if (!token) {
    return NextResponse.json(
      {
        error:
          "No Vercel token provided. Create one at vercel.com/account/tokens and paste it in the Website Builder form — it stays in your browser.",
      },
      { status: 400 }
    );
  }

  const projectName = sanitizeProjectName(
    typeof body.projectName === "string" ? body.projectName : ""
  );
  if (!projectName) {
    return NextResponse.json(
      { error: "projectName must contain at least one letter or digit." },
      { status: 400 }
    );
  }

  const validated = validateFiles(body);
  if ("error" in validated) {
    return NextResponse.json(
      { error: `Cannot deploy: ${validated.error}` },
      { status: 400 }
    );
  }
  const files = validated.files;

  let upstream: Response;
  try {
    upstream = await fetch("https://api.vercel.com/v13/deployments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: projectName,
        files: files.map((f) => ({
          file: f.path,
          data: Buffer.from(f.content, "utf-8").toString("base64"),
        })),
        projectSettings: { framework: null },
      }),
    });
  } catch {
    return NextResponse.json(
      { error: "Could not reach Vercel. Please try again." },
      { status: 502 }
    );
  }

  const data = (await upstream.json().catch(() => null)) as {
    url?: unknown;
    id?: unknown;
    error?: { message?: string; code?: string };
  } | null;

  if (!upstream.ok) {
    const message = data?.error?.message ?? "";
    if (upstream.status === 401 || upstream.status === 403) {
      return NextResponse.json(
        {
          error:
            "Vercel rejected the token. Check it is a valid token from vercel.com/account/tokens and try again.",
        },
        { status: 502 }
      );
    }
    return NextResponse.json(
      {
        error: message
          ? `Vercel deployment failed: ${message.slice(0, 300)}`
          : `Vercel deployment failed (${upstream.status}).`,
      },
      { status: 502 }
    );
  }

  if (!data || typeof data.url !== "string") {
    return NextResponse.json(
      { error: "Vercel did not return a deployment URL." },
      { status: 502 }
    );
  }

  return NextResponse.json({
    url: `https://${data.url}`,
    deploymentId: typeof data.id === "string" ? data.id : null,
    projectName,
  });
}
