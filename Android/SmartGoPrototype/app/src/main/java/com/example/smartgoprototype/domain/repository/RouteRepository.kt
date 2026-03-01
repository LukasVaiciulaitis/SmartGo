package com.example.smartgoprototype.domain.repository

import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.model.TravelMode
import java.time.DayOfWeek

interface RouteRepository {

    suspend fun getRoutes(): List<Route>

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
}
