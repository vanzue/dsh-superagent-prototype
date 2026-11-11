/** Repository-bound GitHub operations shared by daily mirroring and the Discussion source. */
import { randomUUID } from 'node:crypto'
import { writeFile, unlink, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const MUTATIONS = {
  createDiscussion: 'mutation($repo:ID!,$category:ID!,$title:String!,$body:String!){createDiscussion(input:{repositoryId:$repo,categoryId:$category,title:$title,body:$body}){discussion{id number url}}}',
  updateDiscussion: 'mutation($id:ID!,$title:String!,$body:String!){updateDiscussion(input:{discussionId:$id,title:$title,body:$body}){discussion{id}}}',
  addDiscussionComment: 'mutation($id:ID!,$body:String!,$parent:ID){addDiscussionComment(input:{discussionId:$id,body:$body,replyToId:$parent}){comment{id url}}}',
  updateDiscussionComment: 'mutation($id:ID!,$body:String!){updateDiscussionComment(input:{commentId:$id,body:$body}){comment{id}}}',
  closeDiscussion: 'mutation($id:ID!){closeDiscussion(input:{discussionId:$id}){discussion{id}}}',
  reopenDiscussion: 'mutation($id:ID!){reopenDiscussion(input:{discussionId:$id}){discussion{id}}}',
} as const
export const REPOSITORY = 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner discussionCategories(first:100){nodes{id name}}}}'
export const NODE_OWNERS = 'query($ids:[ID!]!){nodes(ids:$ids){... on Repository{id nameWithOwner} ... on Discussion{id repository{nameWithOwner}} ... on DiscussionComment{id discussion{repository{nameWithOwner}}}}}'
const TEXT = 'id body url createdAt updatedAt author{login}'
const DISCUSSION = `${TEXT} number title closed category{name}`
const DISCUSSIONS = `query($owner:String!,$name:String!,$after:String){repository(owner:$owner,name:$name){discussions(first:50,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){nodes{${DISCUSSION}} pageInfo{hasNextPage endCursor}}}}`
const COMMENTS = `query($id:ID!,$after:String){node(id:$id){... on Discussion{repository{nameWithOwner} comments(first:100,after:$after){nodes{${TEXT} replies{totalCount}} pageInfo{hasNextPage endCursor}}}}}`
const REPLIES = `query($id:ID!,$after:String){node(id:$id){... on DiscussionComment{discussion{repository{nameWithOwner}} replies(first:100,after:$after){nodes{${TEXT}} pageInfo{hasNextPage endCursor}}}}}`
export interface RemoteText {
  id: string; body: string; url: string; createdAt: string; updatedAt: string; author: string
  restId?: number; parent?: string
}
export interface RemoteThread extends RemoteText {
  number: number; title: string; closed: boolean; category?: string; labels?: string[]
}
interface GraphText { id: string; body: string; url: string; createdAt: string; updatedAt: string; author: { login: string } | null }
interface GraphDiscussion extends GraphText { number: number; title: string; closed: boolean; category: { name: string } }
interface Connection<T> { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
interface RestText { id: number; node_id: string; body: string | null; html_url: string; created_at: string; updated_at: string; user: { login: string } | null }
interface RestIssue extends RestText { number: number; title: string; state: string; pull_request?: unknown; labels: { name: string }[] }
const graphText = (value: GraphText): RemoteText => ({ ...value, author: value.author?.login ?? 'ghost' })
const restText = (value: RestText): RemoteText => ({
  id: value.node_id, restId: value.id, body: value.body ?? '', url: value.html_url, author: value.user?.login ?? 'ghost',
  createdAt: value.created_at, updatedAt: value.updated_at,
})
export const repositoryName = (value: string): string => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid repository')
  return value
}

/** Uses fixed-repository write methods; JSON files avoid Windows command-line limits for long bodies. */
export class ForkGithub {
  readonly upstream: string
  readonly fork: string
  constructor(upstream: string, fork: string, private readonly directory: string,
    private readonly execute: (args: string[]) => Promise<string>) {
    this.upstream = repositoryName(upstream); this.fork = repositoryName(fork)
  }
  private check(repository: string): void {
    if (![this.upstream, this.fork].includes(repository)) throw new Error('Repository outside mirror scope')
  }
  private async json<T>(path: string, method: string, input?: unknown): Promise<T> {
    let file: string | undefined
    try {
      if (input !== undefined) {
        await mkdir(this.directory, { recursive: true })
        file = join(this.directory, `${randomUUID()}.json`)
        await writeFile(file, JSON.stringify(input), { mode: 0o600 })
      }
      return JSON.parse(await this.execute(['api', path, '--method', method, ...file ? ['--input', file] : []])) as T
    } finally { if (file) await unlink(file) }
  }
  async graph<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const result = await this.json<{ data: T; errors?: { message: string }[] }>('graphql', 'POST', { query, variables })
    if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '))
    return result.data
  }
  async info(repository: string) {
    this.check(repository)
    const [owner, name] = repository.split('/')
    const data = await this.graph<{ repository: { id: string; nameWithOwner: string; discussionCategories: { nodes: { id: string; name: string }[] } } }>(REPOSITORY, { owner, name })
    if (data.repository?.nameWithOwner.toLowerCase() !== repository.toLowerCase()) throw new Error('Repository identity changed')
    return data.repository
  }
  private async restPages<T>(repository: string, path: string): Promise<T[]> {
    this.check(repository)
    const result: T[] = []
    for (let page = 1; ; page++) {
      const items = await this.json<T[]>(`repos/${repository}/${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, 'GET')
      if (!Array.isArray(items)) throw new Error('Expected GitHub list')
      result.push(...items)
      if (items.length < 100) return result
    }
  }
  async issues(repository: string): Promise<RemoteThread[]> {
    return (await this.restPages<RestIssue>(repository, 'issues?state=all&sort=created&direction=asc'))
      .filter(value => !value.pull_request).map(value => ({ ...restText(value), number: value.number, title: value.title,
        closed: value.state === 'closed', labels: value.labels.map(label => label.name) }))
  }
  async issueComments(repository: string, number: number): Promise<RemoteText[]> {
    return (await this.restPages<RestText>(repository, `issues/${number}/comments`)).map(restText)
  }
  async discussions(repository: string): Promise<RemoteThread[]> {
    this.check(repository)
    const [owner, name] = repository.split('/'), items: RemoteThread[] = []
    let after: string | undefined
    do {
      const data = await this.graph<{ repository: { discussions: Connection<GraphDiscussion> } }>(DISCUSSIONS, { owner, name, after })
      const page = data.repository.discussions
      items.push(...page.nodes.map(value => ({ ...graphText(value), number: value.number, title: value.title, closed: value.closed, category: value.category.name })))
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined
    } while (after)
    return items
  }
  async discussionComments(repository: string, id: string): Promise<RemoteText[]> {
    this.check(repository)
    const items: RemoteText[] = []
    let after: string | undefined
    do {
      const data = await this.graph<{ node: { repository: { nameWithOwner: string }; comments: Connection<GraphText & { replies: { totalCount: number } }> } }>(COMMENTS, { id, after })
      if (data.node.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase()) throw new Error('Discussion outside repository')
      const page = data.node.comments
      for (const comment of page.nodes) {
        items.push(graphText(comment))
        if (!comment.replies.totalCount) continue
        let replyAfter: string | undefined
        do {
          const replies = await this.graph<{ node: { discussion: { repository: { nameWithOwner: string } }; replies: Connection<GraphText> } }>(REPLIES, { id: comment.id, after: replyAfter })
          if (replies.node.discussion.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase()) throw new Error('Reply outside repository')
          items.push(...replies.node.replies.nodes.map(value => ({ ...graphText(value), parent: comment.id })))
          replyAfter = replies.node.replies.pageInfo.hasNextPage ? replies.node.replies.pageInfo.endCursor : undefined
        } while (replyAfter)
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined
    } while (after)
    return items
  }
  async createIssue(title: string, body: string): Promise<RemoteThread> {
    const value = await this.json<RestIssue>(`repos/${this.fork}/issues`, 'POST', { title, body })
    return { ...restText(value), number: value.number, title: value.title, closed: false }
  }
  async updateIssue(number: number, title: string, body: string, closed: boolean): Promise<void> {
    await this.json(`repos/${this.fork}/issues/${number}`, 'PATCH', { title, body, state: closed ? 'closed' : 'open' })
  }
  async writeIssueComment(number: number, body: string, existing?: RemoteText): Promise<RemoteText> {
    const value = await this.json<RestText>(`repos/${this.fork}/${existing ? `issues/comments/${existing.restId}` : `issues/${number}/comments`}`,
      existing ? 'PATCH' : 'POST', { body })
    return restText(value)
  }
  async createDiscussion(title: string, body: string, category?: string): Promise<RemoteThread> {
    const repository = await this.info(this.fork)
    const selected = repository.discussionCategories.nodes.find(value => value.name === category)
      ?? repository.discussionCategories.nodes.find(value => value.name === 'General')
      ?? repository.discussionCategories.nodes[0]
    if (!selected) throw new Error('Enable Discussions and create a category on the fork')
    const value = await this.graph<{ createDiscussion: { discussion: { id: string; number: number; url: string } } }>(MUTATIONS.createDiscussion,
      { repo: repository.id, category: selected.id, title, body })
    return { ...value.createDiscussion.discussion, title, body, closed: false, author: '', createdAt: '', updatedAt: '' }
  }
  async updateDiscussion(id: string, title: string, body: string): Promise<void> {
    await this.graph(MUTATIONS.updateDiscussion, { id, title, body })
  }
  async discussionState(id: string, closed: boolean): Promise<void> {
    await this.graph(closed ? MUTATIONS.closeDiscussion : MUTATIONS.reopenDiscussion, { id })
  }
  async writeDiscussionComment(id: string, body: string, parent?: string, existing?: RemoteText): Promise<RemoteText> {
    if (existing) { await this.graph(MUTATIONS.updateDiscussionComment, { id: existing.id, body }); return { ...existing, body } }
    const value = await this.graph<{ addDiscussionComment: { comment: { id: string; url: string } } }>(MUTATIONS.addDiscussionComment, { id, body, parent })
    return { ...value.addDiscussionComment.comment, body, parent, author: '', createdAt: '', updatedAt: '' }
  }
}
