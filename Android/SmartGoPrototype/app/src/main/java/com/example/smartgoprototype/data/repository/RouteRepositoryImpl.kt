package com.example.smartgoprototype.data.repository

import com.example.smartgoprototype.data.remote.api.RoutesApi
import com.example.smartgoprototype.data.remote.dto.CreateRouteRequest
import com.example.smartgoprototype.data.remote.dto.EndpointPlace
import com.example.smartgoprototype.data.remote.dto.GoogleAddressComponentDto
import com.example.smartgoprototype.data.remote.dto.IntermediatePlace
import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.model.TravelMode
import com.example.smartgoprototype.domain.repository.RouteRepository
import java.time.DayOfWeek
import java.time.format.DateTimeFormatter
import java.util.Locale
import javax.inject.Inject

/**
 * Retrofit-backed repository.
 */
class RouteRepositoryImpl @Inject constructor(
    private val api: RoutesApi
) : RouteRepository {

    override suspend fun getRoutes(): List<Route> {
        throw UnsupportedOperationException("Wire GET /routes")
    }

    override suspend fun addRoute(
        title: String,
        origin: PlaceLocation,
        destination: PlaceLocation,
        intermediates: List<PlaceLocation>,
        travelMode: TravelMode,
        schedule: RouteSchedule
    ): Route {
        val request = CreateRouteRequest(
            title = title.trim(),
            origin = origin.toEndpointPlace(requireComponents = true),
            destination = destination.toEndpointPlace(requireComponents = true),
            intermediates = intermediates.map { it.toIntermediate() }.ifEmpty { emptyList() },
            travelMode = travelMode.name,
            arriveBy = schedule.arriveByMinutes.toArriveByHHmm(),
            timezone = schedule.timeZoneId,
            daysOfWeek = schedule.activeDays.toBackendDays()
        )

        val response = api.createRoute(request)

        return Route(
            id = response.route.routeId,
            title = response.route.title,
            origin = PlaceLocation(
                placeId = response.route.origin.placeId,
                label = response.route.origin.label,
                addressComponents = null
            ),
            destination = PlaceLocation(
                placeId = response.route.destination.placeId,
                label = response.route.destination.label,
                addressComponents = null
            ),
            schedule = schedule
        )
    }

    private fun PlaceLocation.toEndpointPlace(requireComponents: Boolean): EndpointPlace {
        val components = addressComponents
        if (requireComponents && components.isNullOrEmpty()) {
            throw IllegalStateException("addressComponents missing for placeId=$placeId")
        }

        return EndpointPlace(
            placeId = placeId,
            label = label,
            addressComponents = (components ?: emptyList()).map {
                GoogleAddressComponentDto(
                    longText = it.longText,
                    shortText = it.shortText,
                    types = it.types
                )
            }
        )
    }

    private fun PlaceLocation.toIntermediate(): IntermediatePlace =
        IntermediatePlace(
            placeId = placeId,
            label = label
        )

    private fun Int.toArriveByHHmm(): String {
        val h = this / 60
        val m = this % 60
        return "%02d:%02d".format(h, m)
    }

    private fun Set<DayOfWeek>.toBackendDays(): List<String> {
        val order = listOf(
            DayOfWeek.MONDAY,
            DayOfWeek.TUESDAY,
            DayOfWeek.WEDNESDAY,
            DayOfWeek.THURSDAY,
            DayOfWeek.FRIDAY,
            DayOfWeek.SATURDAY,
            DayOfWeek.SUNDAY
        )

        return order.filter { contains(it) }.map { it.name.take(3) }
    }
}