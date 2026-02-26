package com.example.smartgoprototype.domain.repository

import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule

interface RouteRepository {

    suspend fun getRoutes(): List<Route>

    suspend fun addRoute(
        title: String,
        origin: PlaceLocation,
        destination: PlaceLocation,
        schedule: RouteSchedule
    ): Route
}