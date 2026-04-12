package com.example.smartgoprototype.domain.repository

import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.model.TravelMode
import java.time.DayOfWeek
import kotlinx.coroutines.flow.Flow

interface RouteRepository {

    /**
     * Observes the local Room cache. Emits a new list whenever the cache changes.
     * Room is the single source of truth — the UI never reads directly from the network.
     */
    fun observeRoutes(): Flow<List<Route>>

    /**
     * Fetches routes from the network and overwrites the local cache.
     * Throws on network failure so the caller can surface an error.
     */
    suspend fun refreshRoutes()

    /** Returns a single cached route by ID, or null if not found. */
    suspend fun getRouteById(routeId: String): Route?

    suspend fun addRoute(
        title: String,
        origin: PlaceLocation,
        destination: PlaceLocation,
        intermediates: List<PlaceLocation>,
        travelMode: TravelMode,
        schedule: RouteSchedule
    ): Route

    suspend fun updateRoute(
        routeId: String,
        title: String? = null,
        travelMode: TravelMode? = null,
        userActive: Boolean? = null,
        arriveByMinutes: Int? = null,
        timezone: String? = null,
        activeDays: Set<DayOfWeek>? = null
    )

    suspend fun deleteRoute(routeId: String)

    /** Persists a new display order for the given routes. Local (Room) only. */
    suspend fun reorderRoutes(orderedIds: List<String>)
}
