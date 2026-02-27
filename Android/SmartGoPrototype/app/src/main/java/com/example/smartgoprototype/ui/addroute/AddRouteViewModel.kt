package com.example.smartgoprototype.ui.addroute

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.example.smartgoprototype.domain.model.PlaceLocation
import com.example.smartgoprototype.domain.model.RouteSchedule
import com.example.smartgoprototype.domain.model.TravelMode
import com.example.smartgoprototype.domain.repository.RouteRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.ZoneId
import javax.inject.Inject

/**
 * ViewModel for Add Route flow.
 *
 * Responsibilities:
 * - Owns form state (title, origin, destination, arrive-by time, active days).
 * - Performs lightweight validation (`canSave`) and triggers repository writes.
 * - Exposes state as a Flow so Compose can collect it and recompose predictably.
 */
@HiltViewModel
class AddRouteViewModel @Inject constructor(
    private val routeRepository: RouteRepository
) : ViewModel() {

    // Backing state is mutable; the UI only sees an immutable StateFlow.
    private val _uiState = MutableStateFlow(AddRouteUiState())
    val uiState: StateFlow<AddRouteUiState> = _uiState

    fun onTitleChange(value: String) {
        // Clear previous errors as the user edits.
        _uiState.value = _uiState.value.copy(title = value, errorMessage = null)
    }

    fun onOriginSelected(place: PlaceLocation) {
        _uiState.value = _uiState.value.copy(origin = place, errorMessage = null)
    }

    fun onDestinationSelected(place: PlaceLocation) {
        _uiState.value = _uiState.value.copy(destination = place, errorMessage = null)
    }

    fun onTravelModeSelected(mode: TravelMode) {
        _uiState.value = _uiState.value.copy(travelMode = mode, errorMessage = null)
    }

    fun onArriveByChange(hour: Int, minute: Int) {
        // Use LocalTime updates so validation stays simple (convert to minutes at save time).
        _uiState.value = _uiState.value.copy(
            arriveBy = _uiState.value.arriveBy.withHour(hour).withMinute(minute),
            errorMessage = null
        )
    }

    fun toggleDay(day: DayOfWeek) {
        // Set operations keep the state updates concise and avoid manual list mutation.
        val days = _uiState.value.activeDays
        _uiState.value = _uiState.value.copy(
            activeDays = if (days.contains(day)) days - day else days + day,
            errorMessage = null
        )
    }

    /**
     * Persists the route via the repository.
     *
     * The callback [onSaved] is triggered by the UI to navigate away only after a successful save.
     */
    fun save(onSaved: () -> Unit) {
        val state = _uiState.value
        if (!state.canSave) return

        // Lock the form while saving to prevent duplicate submissions.
        _uiState.value = state.copy(isSaving = true, errorMessage = null)

        viewModelScope.launch {
            runCatching {
                // Convert LocalTime into a compact, backend-friendly format.
                val schedule = RouteSchedule(
                    arriveByMinutes = state.arriveBy.hour * 60 + state.arriveBy.minute,
                    activeDays = state.activeDays,
                    // Store IANA zone ID so scheduling logic can be interpreted correctly later.
                    timeZoneId = ZoneId.systemDefault().id
                )

                routeRepository.addRoute(
                    title = state.title.trim(),
                    // `canSave` ensures these are non-null; `requireNotNull` keeps the types safe.
                    origin = requireNotNull(state.origin),
                    destination = requireNotNull(state.destination),
                    intermediates = emptyList(),
                    travelMode = state.travelMode,
                    schedule = schedule
                )
            }.onSuccess {
                _uiState.value = _uiState.value.copy(isSaving = false)
                onSaved()
            }.onFailure { e ->
                // Show a user-facing error message while keeping the exception detail available (e.message).
                _uiState.value = _uiState.value.copy(
                    isSaving = false,
                    errorMessage = e.message ?: "Failed to save route"
                )
            }
        }
    }
}