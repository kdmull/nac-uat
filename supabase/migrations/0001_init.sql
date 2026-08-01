--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- CREATE SCHEMA public; (already exists on Supabase by default)


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  INSERT INTO public.profiles (id, email, first_name, last_name, phone)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'first_name',
    NEW.raw_user_meta_data->>'last_name',
    NEW.raw_user_meta_data->>'phone'
  );
  RETURN NEW;
END;
$$;


--
-- Name: nac_mirror_dupr_on_registration(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nac_mirror_dupr_on_registration() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
declare v_first text; v_last text; v_dupr text;
begin
  select first_name, last_name, dupr_id into v_first, v_last, v_dupr
  from profiles where id = new.user_id;
  if v_dupr is not null and new.league_id is not null then
    insert into dupr_players (league_key, player_name, dupr_id)
    values (new.league_id, nac_sched_name(v_first, v_last), v_dupr)
    on conflict (league_key, player_name) do update set dupr_id = excluded.dupr_id;
  end if;
  return new;
end $$;


--
-- Name: nac_sched_name(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nac_sched_name(first text, last text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  SELECT trim(coalesce(first,'')) || ' ' || trim(coalesce(last,''));
$$;


--
-- Name: nac_sync_dupr_from_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nac_sync_dupr_from_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
begin
  if (tg_op = 'INSERT' and new.dupr_id is not null)
     or (tg_op = 'UPDATE' and new.dupr_id is distinct from old.dupr_id) then
    if new.dupr_id is not null then
      insert into dupr_players (league_key, player_name, dupr_id)
      select lm.league_id, nac_sched_name(new.first_name, new.last_name), new.dupr_id
      from league_members lm
      where lm.user_id = new.id and lm.league_id is not null
      on conflict (league_key, player_name) do update set dupr_id = excluded.dupr_id;
    end if;
  end if;
  return new;
end $$;


--
-- Name: nac_sync_dupr_players(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nac_sync_dupr_players() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- When a profile's name changes, update that player's rows in dupr_players
  -- to the new full name (matched by dupr_id).
  IF NEW.dupr_id IS NOT NULL THEN
    UPDATE dupr_players
    SET player_name = nac_sched_name(NEW.first_name, NEW.last_name)
    WHERE dupr_id = NEW.dupr_id
      AND player_name IS DISTINCT FROM nac_sched_name(NEW.first_name, NEW.last_name);
  END IF;
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: dupr_entitlements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dupr_entitlements (
    dupr_id text NOT NULL,
    basic boolean DEFAULT false NOT NULL,
    premium boolean DEFAULT false NOT NULL,
    verified boolean DEFAULT false NOT NULL,
    raw jsonb,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: dupr_matches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dupr_matches (
    identifier text NOT NULL,
    league_key text,
    season_id text,
    week integer,
    match_num integer,
    format text,
    match_code text,
    hashed_code text,
    player_ids text[],
    status text DEFAULT 'active'::text,
    submitted_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone,
    match_id text
);


--
-- Name: dupr_players; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dupr_players (
    id bigint NOT NULL,
    league_key text NOT NULL,
    player_name text NOT NULL,
    dupr_id text NOT NULL,
    access_token text,
    refresh_token text,
    linked_at timestamp with time zone DEFAULT now()
);


--
-- Name: dupr_players_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.dupr_players_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: dupr_players_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.dupr_players_id_seq OWNED BY public.dupr_players.id;


--
-- Name: dupr_ratings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dupr_ratings (
    dupr_id text NOT NULL,
    singles text,
    doubles text,
    singles_reliability numeric,
    doubles_reliability numeric,
    last_event text,
    last_match_id bigint,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: dupr_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dupr_subscriptions (
    dupr_id text NOT NULL,
    subscribed boolean DEFAULT true,
    subscribed_at timestamp with time zone DEFAULT now()
);


--
-- Name: league_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.league_members (
    id bigint NOT NULL,
    league_id text NOT NULL,
    season_id text NOT NULL,
    user_id uuid,
    partner_user_id uuid,
    first_name text,
    last_name text,
    email text,
    phone text,
    partner_name text,
    status text DEFAULT 'active'::text,
    joined_at timestamp with time zone DEFAULT now(),
    partner_status text
);


--
-- Name: league_members_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.league_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: league_members_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.league_members_id_seq OWNED BY public.league_members.id;


--
-- Name: league_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.league_registrations (
    id bigint NOT NULL,
    league_id text NOT NULL,
    league_name text NOT NULL,
    first_name text NOT NULL,
    last_name text NOT NULL,
    email text NOT NULL,
    phone text NOT NULL,
    season text,
    status text DEFAULT 'pending'::text,
    registered_at timestamp with time zone DEFAULT now()
);


--
-- Name: league_registrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.league_registrations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: league_registrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.league_registrations_id_seq OWNED BY public.league_registrations.id;


--
-- Name: pb_league; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pb_league (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: pb_scores_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pb_scores_log (
    id bigint NOT NULL,
    league_key text NOT NULL,
    league_name text,
    week integer,
    match_num integer,
    team1 text,
    team2 text,
    games jsonb,
    winner text,
    submitted_at timestamp with time zone DEFAULT now(),
    dupr_match_code text,
    dupr_hashed_code text
);


--
-- Name: pb_scores_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pb_scores_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pb_scores_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pb_scores_log_id_seq OWNED BY public.pb_scores_log.id;


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    first_name text,
    last_name text,
    email text,
    phone text,
    dupr_id text,
    created_at timestamp with time zone DEFAULT now(),
    is_admin boolean DEFAULT false,
    dupr_access_token text,
    dupr_refresh_token text
);


--
-- Name: public_players; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.public_players WITH (security_invoker=off) AS
 SELECT id,
    first_name,
    last_name,
    dupr_id
   FROM public.profiles;


--
-- Name: stats_rallies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stats_rallies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    video_id uuid NOT NULL,
    rally_number integer NOT NULL,
    serving_team text,
    won_by text,
    ended_by text,
    end_type text,
    start_sec numeric,
    end_sec numeric,
    CONSTRAINT stats_rallies_end_type_check CHECK ((end_type = ANY (ARRAY['winner'::text, 'unforced_error'::text, 'forced_error'::text]))),
    CONSTRAINT stats_rallies_ended_by_check CHECK ((ended_by = ANY (ARRAY['me'::text, 'partner'::text, 'opponent'::text]))),
    CONSTRAINT stats_rallies_serving_team_check CHECK ((serving_team = ANY (ARRAY['us'::text, 'them'::text]))),
    CONSTRAINT stats_rallies_won_by_check CHECK ((won_by = ANY (ARRAY['us'::text, 'them'::text])))
);


--
-- Name: stats_shots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stats_shots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    video_id uuid NOT NULL,
    rally_id uuid NOT NULL,
    shot_number integer,
    timestamp_sec numeric NOT NULL,
    shot_type text NOT NULL,
    wing text,
    direction text,
    quality text,
    error_subtype text,
    CONSTRAINT stats_shots_direction_check CHECK ((direction = ANY (ARRAY['crosscourt'::text, 'middle'::text, 'line'::text]))),
    CONSTRAINT stats_shots_error_subtype_check CHECK ((error_subtype = ANY (ARRAY['net'::text, 'out'::text, 'wide'::text]))),
    CONSTRAINT stats_shots_quality_check CHECK ((quality = ANY (ARRAY['clean'::text, 'attackable'::text, 'error'::text]))),
    CONSTRAINT stats_shots_shot_type_check CHECK ((shot_type = ANY (ARRAY['serve'::text, 'return'::text, 'drop'::text, 'drive'::text, 'dink'::text, 'speedup'::text, 'counter'::text, 'overhead'::text, 'lob'::text, 'reset'::text, 'volley'::text, 'dink_volley'::text, 'atp'::text]))),
    CONSTRAINT stats_shots_wing_check CHECK ((wing = ANY (ARRAY['forehand'::text, 'backhand'::text])))
);


--
-- Name: stats_videos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stats_videos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    played_on date,
    youtube_id text NOT NULL,
    title text,
    partner text,
    opponents text,
    final_score text,
    notes text
);


--
-- Name: dupr_players id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dupr_players ALTER COLUMN id SET DEFAULT nextval('public.dupr_players_id_seq'::regclass);


--
-- Name: league_members id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.league_members ALTER COLUMN id SET DEFAULT nextval('public.league_members_id_seq'::regclass);


--
-- Name: league_registrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.league_registrations ALTER COLUMN id SET DEFAULT nextval('public.league_registrations_id_seq'::regclass);


--
-- Name: pb_scores_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pb_scores_log ALTER COLUMN id SET DEFAULT nextval('public.pb_scores_log_id_seq'::regclass);


--
-- Name: dupr_entitlements dupr_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dupr_entitlements
    ADD CONSTRAINT dupr_entitlements_pkey PRIMARY KEY (dupr_id);


--
-- Name: dupr_matches dupr_matches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dupr_matches
    ADD CONSTRAINT dupr_matches_pkey PRIMARY KEY (identifier);


--
-- Name: dupr_players dupr_players_league_key_player_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dupr_players
    ADD CONSTRAINT dupr_players_league_key_player_name_key UNIQUE (league_key, player_name);


--
-- Name: dupr_players dupr_players_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dupr_players
    ADD CONSTRAINT dupr_players_pkey PRIMARY KEY (id);


--
-- Name: dupr_ratings dupr_ratings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dupr_ratings
    ADD CONSTRAINT dupr_ratings_pkey PRIMARY KEY (dupr_id);


--
-- Name: dupr_subscriptions dupr_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dupr_subscriptions
    ADD CONSTRAINT dupr_subscriptions_pkey PRIMARY KEY (dupr_id);


--
-- Name: league_members league_members_league_id_season_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.league_members
    ADD CONSTRAINT league_members_league_id_season_id_user_id_key UNIQUE (league_id, season_id, user_id);


--
-- Name: league_members league_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.league_members
    ADD CONSTRAINT league_members_pkey PRIMARY KEY (id);


--
-- Name: league_registrations league_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.league_registrations
    ADD CONSTRAINT league_registrations_pkey PRIMARY KEY (id);


--
-- Name: pb_league pb_league_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pb_league
    ADD CONSTRAINT pb_league_pkey PRIMARY KEY (key);


--
-- Name: pb_scores_log pb_scores_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pb_scores_log
    ADD CONSTRAINT pb_scores_log_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: stats_rallies stats_rallies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stats_rallies
    ADD CONSTRAINT stats_rallies_pkey PRIMARY KEY (id);


--
-- Name: stats_rallies stats_rallies_video_id_rally_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stats_rallies
    ADD CONSTRAINT stats_rallies_video_id_rally_number_key UNIQUE (video_id, rally_number);


--
-- Name: stats_shots stats_shots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stats_shots
    ADD CONSTRAINT stats_shots_pkey PRIMARY KEY (id);


--
-- Name: stats_videos stats_videos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stats_videos
    ADD CONSTRAINT stats_videos_pkey PRIMARY KEY (id);


--
-- Name: dupr_matches_league_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX dupr_matches_league_idx ON public.dupr_matches USING btree (league_key, season_id);


--
-- Name: dupr_players_league_name_uidx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX dupr_players_league_name_uidx ON public.dupr_players USING btree (league_key, player_name);


--
-- Name: idx_rallies_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rallies_video ON public.stats_rallies USING btree (video_id);


--
-- Name: idx_shots_rally; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shots_rally ON public.stats_shots USING btree (rally_id);


--
-- Name: idx_shots_video; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_shots_video ON public.stats_shots USING btree (video_id);


--
-- Name: league_members trg_mirror_dupr_on_registration; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_mirror_dupr_on_registration AFTER INSERT ON public.league_members FOR EACH ROW EXECUTE FUNCTION public.nac_mirror_dupr_on_registration();


--
-- Name: profiles trg_sync_dupr_from_profile; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_dupr_from_profile AFTER INSERT OR UPDATE OF dupr_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.nac_sync_dupr_from_profile();


--
-- Name: profiles trg_sync_dupr_players; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_dupr_players AFTER UPDATE OF first_name, last_name, dupr_id ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.nac_sync_dupr_players();


--
-- Name: league_members league_members_partner_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.league_members
    ADD CONSTRAINT league_members_partner_user_id_fkey FOREIGN KEY (partner_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: league_members league_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.league_members
    ADD CONSTRAINT league_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: stats_rallies stats_rallies_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stats_rallies
    ADD CONSTRAINT stats_rallies_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.stats_videos(id) ON DELETE CASCADE;


--
-- Name: stats_shots stats_shots_rally_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stats_shots
    ADD CONSTRAINT stats_shots_rally_id_fkey FOREIGN KEY (rally_id) REFERENCES public.stats_rallies(id) ON DELETE CASCADE;


--
-- Name: stats_shots stats_shots_video_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stats_shots
    ADD CONSTRAINT stats_shots_video_id_fkey FOREIGN KEY (video_id) REFERENCES public.stats_videos(id) ON DELETE CASCADE;


--
-- Name: stats_rallies auth all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "auth all" ON public.stats_rallies USING ((auth.role() = 'authenticated'::text)) WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: stats_shots auth all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "auth all" ON public.stats_shots USING ((auth.role() = 'authenticated'::text)) WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: stats_videos auth all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "auth all" ON public.stats_videos USING ((auth.role() = 'authenticated'::text)) WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: dupr_entitlements; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dupr_entitlements ENABLE ROW LEVEL SECURITY;

--
-- Name: dupr_matches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dupr_matches ENABLE ROW LEVEL SECURITY;

--
-- Name: dupr_players; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dupr_players ENABLE ROW LEVEL SECURITY;

--
-- Name: dupr_ratings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dupr_ratings ENABLE ROW LEVEL SECURITY;

--
-- Name: dupr_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dupr_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: league_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.league_members ENABLE ROW LEVEL SECURITY;

--
-- Name: league_registrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.league_registrations ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles own profile insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own profile insert" ON public.profiles FOR INSERT WITH CHECK ((auth.uid() = id));


--
-- Name: profiles own profile read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own profile read" ON public.profiles FOR SELECT USING ((auth.uid() = id));


--
-- Name: profiles own profile update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own profile update" ON public.profiles FOR UPDATE USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: league_members own registration delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own registration delete" ON public.league_members FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: league_members own registration insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own registration insert" ON public.league_members FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: league_members own registration update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own registration update" ON public.league_members FOR UPDATE TO authenticated USING (((auth.uid() = user_id) OR (auth.uid() = partner_user_id))) WITH CHECK (((auth.uid() = user_id) OR (auth.uid() = partner_user_id)));


--
-- Name: pb_league; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pb_league ENABLE ROW LEVEL SECURITY;

--
-- Name: pb_scores_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pb_scores_log ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: dupr_matches public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read" ON public.dupr_matches FOR SELECT USING (true);


--
-- Name: dupr_players public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read" ON public.dupr_players FOR SELECT USING (true);


--
-- Name: dupr_ratings public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read" ON public.dupr_ratings FOR SELECT USING (true);


--
-- Name: dupr_subscriptions public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read" ON public.dupr_subscriptions FOR SELECT USING (true);


--
-- Name: league_members public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read" ON public.league_members FOR SELECT USING (true);


--
-- Name: pb_league public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read" ON public.pb_league FOR SELECT USING (true);


--
-- Name: pb_scores_log public read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "public read" ON public.pb_scores_log FOR SELECT USING (true);


--
-- Name: stats_rallies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stats_rallies ENABLE ROW LEVEL SECURITY;

--
-- Name: stats_shots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stats_shots ENABLE ROW LEVEL SECURITY;

--
-- Name: stats_videos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stats_videos ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--


