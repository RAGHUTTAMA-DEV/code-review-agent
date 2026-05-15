import axios from 'axios';
import prisma from '../prismaClient';
export async function getQwenEmbedding(text: string): Promise<number[]> {
  const response = await axios.post(
    'http://localhost:11434/api/embeddings',
    {
      model: 'qwen2.5:0.5b', 
      prompt: text
    },
    {
      headers: {
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.embedding;
}

export async function saveEmbeddings(content: string, fileId: string) {
  const codeChunks = await getQwenEmbedding(content);

  // Note: Prisma requires $executeRaw for writing vectors.
  // We stringify the array so Postgres can cast it to the vector type.
  await prisma.$executeRaw`
    INSERT INTO "Document" (id, content, embedding)
    VALUES (
      gen_random_uuid(),
      ${content},
      ${JSON.stringify(codeChunks)}::vector
    )
  `;
}

export async function searchDocuments(queryChunks: number[], limit: number) {
  // Prisma $queryRaw uses parameterized queries for safety.
  const results = await prisma.$queryRaw`
    SELECT id, content, embedding <=> ${JSON.stringify(queryChunks)}::vector AS distance
    FROM "Document"
    ORDER BY distance ASC
    LIMIT ${limit};
  `;

  //@ts-ignore
  return results.map((row: any) => ({
    id: row.id,
    content: row.content,
    distance: row.distance
  }));
}
