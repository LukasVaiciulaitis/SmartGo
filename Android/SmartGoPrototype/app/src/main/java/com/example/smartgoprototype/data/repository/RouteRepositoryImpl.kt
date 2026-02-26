package com.example.smartgoprototype.data.repository

import com.example.smartgoprototype.data.remote.api.RoutesApi
import com.example.smartgoprototype.data.remote.dto.CreateRouteRequest
import com.example.smartgoprototype.data.remote.dto.toDomain
import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.repository.RouteRepository
import javax.inject.Inject

/**
 * Retrofit-backed repository (backend not yet updated)
 * NOT WIRED IN DI
 */
class RouteRepositoryImpl @Inject constructor(
    private val api: RoutesApi
) : RouteRepository {

    override suspend fun getRoutes(): List<Route> {
        // Backend currently returns legacy string origin/destination, so toDomain() must do a temporary mapping.
        return api.getRoutes().map { it.toDomain() }
    }

    override suspend fun addRoute(
        title: String,
        origin: PlaceLocation,
        destination: PlaceLocation,
        schedule: RouteSchedule
    ): Route {
        // Backend not yet updated to accept PlaceLocation + schedule.
        throw UnsupportedOperationException(
            "RouteRepositoryImpl.addRoute() not supported until backend accepts PlaceLocation + schedule."
        )

        // When backend is ready
        // val request = CreateRouteRequestV2(title, origin, destination, schedule)
        // return api.createRouteV2(request).toDomain()
    }
}