-- The landing contact outbox is an internal backend queue.  Browser clients
-- never query it: the API and the delivery worker use the Supabase service
-- role, which bypasses RLS.  With no client policies, anon/authenticated
-- access is denied by default while the backend keeps its existing access.
ALTER TABLE public.landing_contact_outbox ENABLE ROW LEVEL SECURITY;
