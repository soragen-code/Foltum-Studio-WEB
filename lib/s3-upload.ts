import { PutObjectCommand } from "@aws-sdk/client-s3";
import { createS3Client, getBucketConfig } from "./aws-config";

const s3 = createS3Client();

/**
 * Download a file from a remote URL and upload it to S3.
 * Returns the public S3 URL.
 */
export async function uploadRemoteToS3(
  remoteUrl: string,
  key: string,
  contentType: string
): Promise<string> {
  const { bucketName } = getBucketConfig();
  const region = process.env.AWS_REGION ?? "us-east-1";

  const res = await fetch(remoteUrl);
  if (!res.ok) throw new Error(`Failed to fetch remote file: ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
}

/**
 * Upload an in-memory buffer to S3.
 * Returns the public S3 URL.
 */
export async function uploadBufferToS3(
  buffer: Buffer,
  key: string,
  contentType: string
): Promise<string> {
  const { bucketName } = getBucketConfig();
  const region = process.env.AWS_REGION ?? "us-east-1";

  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );

  return `https://${bucketName}.s3.${region}.amazonaws.com/${key}`;
}
