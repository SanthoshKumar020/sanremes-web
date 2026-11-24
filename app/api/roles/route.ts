import { NextResponse } from "next/server";
import { publicRoles } from "@/lib/roles";

export async function GET() {
  return NextResponse.json({ roles: publicRoles() });
}
