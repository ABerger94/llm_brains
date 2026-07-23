import { NextRequest, NextResponse } from "next/server";
import { appendEpisode, clearMind, getMindData, isBackendConfigured, setIdentityNarrative } from "@/lib/server/memoryDb";

export const runtime = "nodejs";

function requireMindId(req: NextRequest): string | null {
  const mindId = req.nextUrl.searchParams.get("mindId");
  return mindId && mindId.length > 0 ? mindId : null;
}

export async function GET(req: NextRequest) {
  const mindId = requireMindId(req);
  if (!mindId) return NextResponse.json({ error: "missing mindId" }, { status: 400 });
  const data = await getMindData(mindId);
  return NextResponse.json({ ...data, backendConfigured: isBackendConfigured() });
}

interface SaveBody {
  mindId?: string;
  identityNarrative?: string;
  newEpisode?: {
    timestamp: number;
    stimulus: string;
    emotion: string;
    reasoning: string;
    voice: string;
  };
}

export async function POST(req: NextRequest) {
  let body: SaveBody;
  try {
    body = (await req.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const mindId = body.mindId;
  if (!mindId) return NextResponse.json({ error: "missing mindId" }, { status: 400 });

  if (typeof body.identityNarrative === "string") {
    await setIdentityNarrative(mindId, body.identityNarrative);
  }
  if (body.newEpisode) {
    await appendEpisode(mindId, body.newEpisode);
  }

  const data = await getMindData(mindId);
  return NextResponse.json({ ...data, backendConfigured: isBackendConfigured() });
}

export async function DELETE(req: NextRequest) {
  const mindId = requireMindId(req);
  if (!mindId) return NextResponse.json({ error: "missing mindId" }, { status: 400 });
  await clearMind(mindId);
  return NextResponse.json({ ok: true });
}
