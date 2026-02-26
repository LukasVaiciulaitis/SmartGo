package com.example.smartgoprototype.data.repository

import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.repository.RouteRepository
import kotlinx.coroutines.delay
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class RouteRepositoryStub @Inject constructor() : RouteRepository {

    private val routes = mutableListOf<Route>()

    override suspend fun getRoutes(): List<Route> {
        delay(150) // simulate IO
        return routes.toList()
    }

    override suspend fun addRoute(
        title: String,
        origin: PlaceLocation,
        destination: PlaceLocation,
        schedule: RouteSchedule
    ): Route {
        delay(200) // simulate IO

        val created = Route(
            id = UUID.randomUUID().toString(),
            title = title,
            origin = origin,
            destination = destination,
            schedule = schedule
        )
        routes.add(created)
        return created
    }
}