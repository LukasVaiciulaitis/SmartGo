package com.example.smartgoprototype.data.repository

import com.example.smartgoprototype.data.remote.api.RoutesApi
import com.example.smartgoprototype.data.remote.dto.CreateRouteRequest
import com.example.smartgoprototype.data.remote.dto.DeleteRouteRequestDto
import com.example.smartgoprototype.data.remote.dto.EndpointPlace
import com.example.smartgoprototype.data.remote.dto.FetchedRouteDto
import com.example.smartgoprototype.data.remote.dto.GoogleAddressComponentDto
import com.example.smartgoprototype.data.remote.dto.IntermediatePlace
import com.example.smartgoprototype.data.remote.dto.RouteCreatedDto
import com.example.smartgoprototype.data.remote.dto.UpdateRouteRequestDto
import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.Route
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.model.TravelMode
import com.example.smartgoprototype.domain.repository.RouteRepository
import java.io.IOException
import java.time.DayOfWeek
import javax.inject.Inject
import org.json.JSONObject
import retrofit2.HttpException

/**
 * Retrofit-backed repository.
 *
 * Mapping currently performed inside the repository, considering
 * dedicated mapper class to tidy repository
 *
 */
class RouteRepositoryImpl @Inject constructor(
    private val api: RoutesApi
) : RouteRepository {

    override suspend fun getRoutes(): List<Route> {
        val response = executeApiCall { api.getRoutes() }
        return response.routes.map { it.toDomainRoute() }
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

        val response = executeApiCall { api.createRoute(request) }

        return response.route.toDomainRoute(fallbackSchedule = schedule)
    }

    override suspend fun updateRoute(
        routeId: String,
        title: String?,
        travelMode: TravelMode?,
        userActive: Boolean?,
        arriveByMinutes: Int?,
        timezone: String?,
        activeDays: Set<DayOfWeek>?
    ) {
        val request = UpdateRouteRequestDto(
            routeId = routeId,
            title = title?.trim(),
            travelMode = travelMode?.name,
            userActive = userActive,
            arriveBy = arriveByMinutes?.toArriveByHHmm(),
            timezone = timezone,
            daysOfWeek = activeDays?.toBackendDays()
        )

        executeApiCall { api.updateRoute(request) }
    }

    override suspend fun deleteRoute(routeId: String) {
        val request = DeleteRouteRequestDto(routeId = routeId)
        executeApiCall { api.deleteRoute(request) }
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

    private fun RouteCreatedDto.toDomainRoute(fallbackSchedule: RouteSchedule): Route {
        val mappedSchedule = schedule.toDomainScheduleOrNull() ?: fallbackSchedule
        return Route(
            id = routeId,
            title = title,
            origin = PlaceLocation(
                placeId = origin.placeId,
                label = origin.label,
                addressComponents = null
            ),
            destination = PlaceLocation(
                placeId = destination.placeId,
                label = destination.label,
                addressComponents = null
            ),
            schedule = mappedSchedule
        )
    }

    private fun FetchedRouteDto.toDomainRoute(): Route {
        val mappedSchedule = schedule.toDomainScheduleOrNull() ?: RouteSchedule(
            arriveByMinutes = 9 * 60,
            activeDays = emptySet(),
            timeZoneId = "UTC"
        )

        return Route(
            id = routeId,
            title = title,
            origin = PlaceLocation(
                placeId = origin.placeId,
                label = origin.label,
                addressComponents = null
            ),
            destination = PlaceLocation(
                placeId = destination.placeId,
                label = destination.label,
                addressComponents = null
            ),
            schedule = mappedSchedule
        )
    }

    private fun com.example.smartgoprototype.data.remote.dto.CreatedScheduleDto?.toDomainScheduleOrNull(): RouteSchedule? {
        val schedule = this ?: return null
        return RouteSchedule(
            arriveByMinutes = schedule.arriveBy.toMinutesSinceMidnightOrDefault(),
            activeDays = schedule.daysOfWeek.toDomainDays(),
            timeZoneId = schedule.timezone
        )
    }

    private fun String.toMinutesSinceMidnightOrDefault(): Int {
        val parts = split(":")
        if (parts.size != 2) return 9 * 60
        val hour = parts[0].toIntOrNull() ?: return 9 * 60
        val minute = parts[1].toIntOrNull() ?: return 9 * 60
        if (hour !in 0..23 || minute !in 0..59) return 9 * 60
        return hour * 60 + minute
    }

    private fun List<String>.toDomainDays(): Set<DayOfWeek> {
        val map = mapOf(
            "MON" to DayOfWeek.MONDAY,
            "TUE" to DayOfWeek.TUESDAY,
            "WED" to DayOfWeek.WEDNESDAY,
            "THU" to DayOfWeek.THURSDAY,
            "FRI" to DayOfWeek.FRIDAY,
            "SAT" to DayOfWeek.SATURDAY,
            "SUN" to DayOfWeek.SUNDAY
        )
        return mapNotNull { map[it] }.toSet()
    }

    private suspend fun <T> executeApiCall(block: suspend () -> T): T {
        return try {
            block()
        } catch (t: Throwable) {
            throw t.toRepositoryException()
        }
    }

    private fun Throwable.toRepositoryException(): Exception {
        return when (this) {
            is HttpException -> Exception(httpErrorMessage(), this)
            is IOException -> Exception("Network error. Please check your connection and try again.", this)
            else -> Exception(message ?: "Unexpected error", this)
        }
    }

    private fun HttpException.httpErrorMessage(): String {
        val code = code()
        val serverMessage = runCatching {
            response()?.errorBody()?.string()
                ?.let { JSONObject(it).optString("error") }
                ?.takeIf { it.isNotBlank() }
        }.getOrNull()

        if (!serverMessage.isNullOrBlank()) return serverMessage

        return when (code) {
            400 -> "Invalid request."
            401 -> "Unauthorised - please sign in again."
            422 -> "Route could not be processed"
            500 -> "Internal Server error. Please try again."
            503 -> "Routing service temporarily unavailable. Please try again."
            else -> "Request failed with HTTP $code."
        }
    }
}
