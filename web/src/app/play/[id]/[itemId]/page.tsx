import { Suspense } from "react";
import SharedPlayer from "@/components/SharedPlayer";
/** Keyed by the item, so moving on to the next season starts the player afresh instead of carrying the last season's state over. The ?file= choice is read once, when the player opens. */
export default async function PlayPage({ params }: { params: Promise<{ itemId: string }> }) { const { itemId } = await params; return <Suspense fallback={null}><SharedPlayer key={itemId} /></Suspense>; }
