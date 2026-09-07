export const dynamic = "force-dynamic";
import { NextResponse } from 'next/server'
import { auth } from '@/auth'
import { generatePresignedUploadUrl } from '@/lib/s3'

export async function POST(request: Request) {
  try {
    const session = await auth()
    if (!session?.user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { fileName, contentType, isPublic } = await request.json()
    if (!fileName || !contentType) {
      return NextResponse.json({ error: 'fileName and contentType required' }, { status: 400 })
    }

    const { uploadUrl, cloud_storage_path } = await generatePresignedUploadUrl(
      fileName,
      contentType,
      isPublic ?? false
    )

    return NextResponse.json({ uploadUrl, cloud_storage_path })
  } catch (err: any) {
    console.error('Presigned URL error:', err)
    return NextResponse.json({ error: 'Failed to generate URL' }, { status: 500 })
  }
}
