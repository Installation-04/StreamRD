import SharedPlayer from "@/components/SharedPlayer";
/** Keyed by the item, so moving on to the next season starts the player afresh instead of carrying the last season's state over. */
export default async function PlayPage({ params }: { params: Promise<{ itemId: string }> }) { const { itemId } = await params; return <SharedPlayer key={itemId} />; }
